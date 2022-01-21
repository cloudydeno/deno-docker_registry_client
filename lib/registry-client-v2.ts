/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Sha256 } from "https://deno.land/std@0.105.0/hash/sha256.ts";

import {
    parseIndex, parseRepo,
    isLocalhost,
    urlFromIndex,
    DEFAULT_USERAGENT,
    splitIntoTwo,
} from "./common.ts";
import {
    Manifest,
    RegistryIndex, RegistryImage,
    RegistryClientOpts,
    AuthInfo,
    TagList,
    ManifestOCIIndex,
    ManifestOCI,
} from "./types.ts";
import { DockerJsonClient, DockerResponse } from "./docker-json-client.ts";
import { Parse_WWW_Authenticate } from "./www-authenticate.ts";
import * as e from "./errors.ts";

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * Docker Registry API v2 client. See the README for an intro.
 *
 * <https://docs.docker.com/registry/spec/api/>
 */

// --- Globals

// https://github.com/docker/docker/blob/77da5d8/registry/config_unix.go#L10
const DEFAULT_V2_REGISTRY = 'https://registry-1.docker.io';
const MAX_REGISTRY_ERROR_LENGTH = 10000;

export const MEDIATYPE_MANIFEST_V2
    = 'application/vnd.docker.distribution.manifest.v2+json';
export const MEDIATYPE_MANIFEST_LIST_V2
    = 'application/vnd.docker.distribution.manifest.list.v2+json';

export const MEDIATYPE_OCI_MANIFEST_V1
    = 'application/vnd.oci.image.manifest.v1+json';
export const MEDIATYPE_OCI_MANIFEST_INDEX_V1
    = 'application/vnd.oci.image.index.v1+json';

/*
 * Set the "Authorization" HTTP header into the headers object from the given
 * auth info.
 * - Bearer auth if `token`.
 * - Else, Basic auth if `username`.
 * - Else, if the authorization key exists, then it is removed from headers.
 */
function _setAuthHeaderFromAuthInfo(headers: Headers, authInfo: AuthInfo | null) {
    if (authInfo?.type === 'Bearer') {
        headers.set('authorization', 'Bearer ' + authInfo.token);
    } else if (authInfo?.type === 'Basic') {
        const credentials = `${authInfo.username ?? ''}:${authInfo.password ?? ''}`;
        headers.set('authorization', 'Basic ' + btoa(credentials));
    } else {
        headers.delete('authorization');
    }
    return headers;
}

/**
 * Special handling of errors from the registry server.
 *
 * Some registry errors will use a custom error format, so detect those
 * and convert these as necessary.
 *
 * Example JSON response for a missing repo:
 * {
 *   "jse_shortmsg": "",
 *   "jse_info": {},
 *   "message": "{\"errors\":[{\"code\":\"UNAUTHORIZED\",\"message\":\"...}\n",
 *   "body": {
 *       "errors": [{
 *           "code": "UNAUTHORIZED",
 *           "message": "authentication required",
 *           "detail": [{
 *               "Type": "repository",
 *               "Class": "",
 *               "Name": "library/idontexist",
 *               "Action": "pull"
 *           }]
 *       }]
 *   }
 * }
 *
 * Example JSON response for bad username/password:
 * {
 *   "statusCode": 401,
 *   "jse_shortmsg":"",
 *   "jse_info":{},
 *   "message":"{\"details\":\"incorrect username or password\"}\n",
 *   "body":{
 *     "details": "incorrect username or password"
 *   }
 * }
 *
 * Example AWS token error:
 * {
 *   "statusCode": 400,
 *   "errors": [
 *     {
 *       "code": "DENIED",
 *       "message": "Your Authorization Token is invalid."
 *     }
 *   ]
 * }
 */
function _getRegistryErrorMessage(err: any) {
    if (err.body && Array.isArray(err.body.errors) && err.body.errors[0]) {
        return err.body.errors[0].message;
    } else if (err.body && err.body.details) {
        return err.body.details;
    } else if (Array.isArray(err.errors) && err.errors[0].message) {
        return err.errors[0].message;
    } else if (err.message) {
        return err.message;
    } else if (err.details) {
        return err.details;
    }
    return err.toString();
}

/**
 * Return a scope string to be used for an auth request. Example:
 *   repository:library/nginx:pull
 */
function _makeAuthScope(resource: string, name: string, actions: string[]) {
    return `${resource}:${name}:${actions.join(',')}`;
}

/**
 * Special handling of JSON body errors from the registry server.
 *
 * POST/PUT endpoints can return an error in the body of the response.
 * We want to check for that and get the error body message and return it.
 *
 * Usage:
 *      var regErr = _getRegistryErrMessage(body));
 */
function _getRegistryErrMessage(body: any) {
    if (!body) {
        return null;
    }
    var obj = body;
    if (typeof (obj) === 'string' && obj.length <= MAX_REGISTRY_ERROR_LENGTH) {
        try {
            obj = JSON.parse(obj);
        } catch (ex) {
            // Just return the error as a string.
            return obj;
        }
    }
    if (typeof (obj) !== 'object' || !obj.hasOwnProperty('errors')) {
        return null;
    }
    if (!Array.isArray(obj.errors)) {
        return null;
    }
    // Example obj:
    // {
    //     "errors": [
    //         {
    //             "code": "MANIFEST_INVALID",
    //             "message": "manifest invalid",
    //             "detail": {}
    //         }
    //     ]
    // }
    if (obj.errors.length === 1) {
        return obj.errors[0].message;
    } else {
        return obj.errors.map(function (o: any) {
            return o.message;
        }).join(', ');
    }
}


// The Docker Registry will usually provide a more detailed JSON error message
// in the response body, so try to read that data in order to get a more
// detailed error msg.
async function registryError(err: any, res: DockerResponse) {
    // Parse errors in the response body.
    var message = _getRegistryErrMessage(await res.dockerJson());
    if (message) {
        err.message = message;
    }
    return Promise.reject(err);
}

/**
 * Parse a WWW-Authenticate header like this:
 *
 *      // JSSTYLED
 *      www-authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
 *      www-authenticate: Basic realm="registry456.example.com"
 *
 * into an object like this:
 *
 *      {
 *          scheme: 'Bearer',
 *          parms: {
 *              realm: 'https://auth.docker.io/token',
 *              service: 'registry.docker.io'
 *          }
 *      }
 *
 * Note: This doesn't handle *multiple* challenges. I've not seen a concrete
 * example of that.
 */
function _parseWWWAuthenticate(header: string) {
    var parsed = new Parse_WWW_Authenticate(header);
    if (parsed.err) {
        throw new Error('could not parse WWW-Authenticate header "' + header
            + '": ' + parsed.err);
    }
    return parsed;
}

/*
 * Parse the 'Docker-Content-Digest' header.
 *
 * @throws {BadDigestError} if the value is missing or malformed
 */
function _parseDockerContentDigest(dcd: string) {
    if (!dcd) throw new e.BadDigestError(
        'missing "Docker-Content-Digest" header');
    const errPre = `could not parse Docker-Content-Digest header "${dcd}": `;

    // E.g. docker-content-digest: sha256:887f7ecfd0bda3...
    var parts = splitIntoTwo(dcd, ':');
    if (parts.length !== 2) throw new e.BadDigestError(
        errPre + JSON.stringify(dcd));
    if (parts[0] !== 'sha256') throw new e.BadDigestError(
        errPre + 'Unsupported hash algorithm ' + JSON.stringify(parts[0]));

    return {
        raw: dcd,
        algorithm: parts[0],
        expectedDigest: parts[1],
        startHash() { switch (this.algorithm) {
            case 'sha256': return new Sha256();
            default: throw new e.BadDigestError(`Unsupported hash algorithm ${this.algorithm}`);
        } },
        get validationStream() {
            const hash = this.startHash();
            return new TransformStream<Uint8Array,Uint8Array>({
                transform: (chunk, controller) => {
                    hash.update(chunk);
                    controller.enqueue(chunk);
                },
                flush: (controller) => {
                    const digest = hash.hex();
                    if (this.expectedDigest === digest) return;
                    controller.error(new e.BadDigestError(`Docker-Content-Digest (${this.expectedDigest} vs ${digest})`));
                },
            })
        }
    };
}

/**
 * Calculate the 'Docker-Content-Digest' header for the given manifest.
 *
 * @returns {String} The docker digest string.
 * @throws {InvalidContentError} if there is a problem parsing the manifest.
 */
export function digestFromManifestStr(manifestStr: string): string {
    var hash = new Sha256();
    var digestPrefix = 'sha256:';

    var manifest;
    try {
        manifest = JSON.parse(manifestStr);
    } catch (err) {
        throw new Error(`could not parse manifest: ${err.message}\n${manifestStr}`);
    }
    if (manifest.schemaVersion === 1) {
        throw new Error(`schemaVersion 1 is not supported by /x/docker_registry_client.`);
    }
    hash.update(manifestStr);
    return digestPrefix + hash.hex();
}


export class RegistryClientV2 {
    readonly version = 2;
    insecure: boolean;
    repo: RegistryImage;
    acceptOCIManifests: boolean;
    acceptManifestLists: boolean;
    username?: string;
    password?: string;
    scopes: string[];
    private _loggedIn: boolean;
    private _loggedInScope?: string | null;
    private _authInfo?: AuthInfo | null;
    private _headers: Headers;
    private _url: string;
    private _commonHttpClientOpts: {
        userAgent: string;
    }

    /**
     * Create a new Docker Registry V2 client for a particular repository.
     *
     * @param opts.insecure {Boolean} Optional. Default false. Set to true
     *      to *not* fail on an invalid or this-signed server certificate.
     * ... TODO: lots more to document
     *
     */
    constructor(opts: RegistryClientOpts) {
        this.insecure = Boolean(opts.insecure);
        if (opts.repo) {
            this.repo = {
                ...opts.repo,
                index: { ...opts.repo.index },
            };
        } else if (opts.name) {
            this.repo = parseRepo(opts.name);
        } else throw new Error(`name or repo required`);
        if (opts.scheme) {
            this.repo.index.scheme = opts.scheme;
        } else if (!this.repo.index.scheme &&
            isLocalhost(this.repo.index.name))
        {
            // Per docker.git:registry/config.go#NewServiceConfig we special
            // case localhost to allow HTTP. Note that this lib doesn't do
            // the "try HTTPS, then fallback to HTTP if allowed" thing that
            // Docker-docker does, we'll just prefer HTTP for localhost.
            this.repo.index.scheme = 'http';
        }

        this.acceptOCIManifests = opts.acceptOCIManifests || false;
        this.acceptManifestLists = opts.acceptManifestLists || false;
        this.username = opts.username;
        this.password = opts.password;
        this.scopes = opts.scopes ?? ['pull'];
        this._loggedIn = false;
        this._loggedInScope = null; // Keeps track of the login type.
        this._authInfo = null;
        this._headers = new Headers();

        if (opts.token) {
            _setAuthHeaderFromAuthInfo(this._headers, {
                type: 'Bearer',
                token: opts.token,
            });
        } else if (opts.username || opts.password) {
            _setAuthHeaderFromAuthInfo(this._headers, {
                type: 'Basic',
                username: opts.username ?? '',
                password: opts.password ?? '',
            });
        } else {
            _setAuthHeaderFromAuthInfo(this._headers, {
                type: 'None',
            });
        }

        if (this.repo.index.official) {  // v1
            this._url = DEFAULT_V2_REGISTRY;
        } else {
            this._url = urlFromIndex(this.repo.index);
        }
        // this.log.trace({url: this._url}, 'RegistryClientV2 url');

        this._commonHttpClientOpts = {
            userAgent: opts.userAgent || DEFAULT_USERAGENT,
        };
    }

    private get _api() {
        return new DockerJsonClient({
            url: this._url,
            ...this._commonHttpClientOpts,
        });
    }

    /**
     * Ping the base URL.
     * See: <https://docs.docker.com/registry/spec/api/#base>
     *
     * Use `res.status` to infer information:
     *          404     This registry URL does not support the v2 API.
     *          401     Authentication is required (or failed). Use the
     *                  WWW-Authenticate header for the appropriate auth method.
     *                  This `res` can be passed to `login()` to handle
     *                  authenticating.
     *          200     Successful authentication. The response body is `body`
     *                  if wanted.
     */
    async ping(opts: {
        headers?: Headers,
        expectStatus?: number[],
    } = {}) {
        const resp = await this._api.request({
            method: 'GET',
            path: '/v2/',
            headers: opts.headers,
            expectStatus: opts.expectStatus ?? [200, 401, 404],
            // Ping should be fast. We don't want 15s of retrying.
            retry: false,
            connectTimeout: 10000,
        });
        await resp.dockerBody();
        return resp;
    }

    /**
     * Login V2
     *
     * Typically one does not need to call this function directly because most
     * methods of a `RegistryClientV2` will automatically login as necessary.
     * Once exception is the `ping` method, which intentionally does not login.
     * That is because the point of the ping is to determine quickly if the
     * registry supports v2, which doesn't require the extra work of logging in.
     *
     * This attempts to reproduce the logic of "docker.git:registry/auth.go#loginV2"
     *
     * @param opts {Object}
     *      - opts.scope {String} Optional. A scope string passed in for
     *        bearer/token auth. If this is just a login request where the token
     *        won't be used, then the empty string (the default) is sufficient.
     *        // JSSTYLED
     *        See <https://github.com/docker/distribution/blob/master/docs/spec/auth/token.md#requesting-a-token>
     *      - opts.pingRes {Object} Optional. The response object from an earlier
     *        `ping()` call. This can be used to save re-pinging.
     *      ...
     * @return an object with authentication info, examples:
     *                          {type: 'Basic', username: '...', password: '...'}
     *                          {type: 'Bearer', token: '...'}
     *                          {type: 'None'}
     */
    async performLogin(opts: {
        scope?: string;
        pingRes?: DockerResponse;
    }): Promise<AuthInfo> {
        let res = opts.pingRes;
        if (!res?.headers.get('www-authenticate')) {
            res = await this.ping({
                expectStatus: [200, 401],
            });
            if (res.status === 200) {
                // No authorization is necessary.
                return { type: 'None' };
            }
        };

        const chalHeader = res.headers.get('www-authenticate');
        if (!chalHeader) throw await res.dockerThrowable(
            'missing WWW-Authenticate header from "GET /v2/" (see ' +
            'https://docs.docker.com/registry/spec/api/#api-version-check)');

        const authChallenge = _parseWWWAuthenticate(chalHeader);
        if (authChallenge.scheme.toLowerCase() === 'basic') return {
            type: 'Basic',
            username: this.username ?? '',
            password: this.password ?? ''
        };
        if (authChallenge.scheme.toLowerCase() === 'bearer') return {
            type: 'Bearer',
            token: await this._getToken({
                realm: authChallenge.parms.realm,
                service: authChallenge.parms.service,
                scopes: opts.scope ? [opts.scope] : [],
            }),
        };
        throw new Error(
            `unsupported auth scheme: "${authChallenge.scheme}"`);
    }

    /**
     * Get an auth token.
     *
     * See: docker/docker.git:registry/token.go
     */
    async _getToken(opts: {
        realm: string;
        service?: string;
        scopes?: string[];
    }): Promise<string> {
        // - add https:// prefix (or http) if none on 'realm'
        var tokenUrl = opts.realm;
        var match = /^(\w+):\/\//.exec(tokenUrl);
        if (!match) {
            tokenUrl = (this.insecure ? 'http' : 'https') + '://' + tokenUrl;
        } else if (['http', 'https'].indexOf(match[1]) === -1) {
            throw new Error('unsupported scheme for ' +
                `WWW-Authenticate realm "${opts.realm}": "${match[1]}"`);
        }

        // - GET $realm
        //      ?service=$service
        //      (&scope=$scope)*
        //      (&account=$username)
        //   Authorization: Basic ...
        var headers = new Headers;
        var query = new URLSearchParams;
        if (opts.service) {
            query.set('service', opts.service);
        }
        if (opts.scopes && opts.scopes.length) {
            for (const scope of opts.scopes) {
                query.append('scope', scope);  // intentionally singular 'scope'
            }
        }
        if (this.username) {
            query.set('account', this.username);
            _setAuthHeaderFromAuthInfo(headers, {
                type: 'Basic',
                username: this.username,
                password: this.password ?? '',
            });
        }
        if (query.toString()) {
            tokenUrl += '?' + query.toString();
        }
        // log.trace({tokenUrl: tokenUrl}, '_getToken: url');

        var parsedUrl = new URL(tokenUrl);
        var client = new DockerJsonClient({
            url: parsedUrl.origin,
            ...this._commonHttpClientOpts,
        });
        const resp = await client.request({
            method: 'GET',
            path: parsedUrl.href.slice(parsedUrl.origin.length),
            headers: headers,
            expectStatus: [200, 401],
        });
        if (resp.status === 401) {
            // Convert *all* 401 errors to use a generic error constructor
            // with a simple error message.
            var errMsg = _getRegistryErrorMessage(await resp.dockerJson());
            throw await resp.dockerThrowable('Registry auth failed: '+errMsg);
        }
        const body = await resp.dockerJson();
        if (typeof body.token !== 'string') {
            console.error('TODO: auth resp:', body);
            throw await resp.dockerThrowable('authorization ' +
                'server did not include a token in the response');
        }
        return body.token;
    }


    /**
     * Get a registry session (i.e. login to the registry).
     *
     * Typically one does not need to call this method directly because most
     * methods of a client will automatically login as necessary.
     * Once exception is the `ping` method, which intentionally does not login.
     * That is because the point of the ping is to determine quickly if the
     * registry supports v2, which doesn't require the extra work of logging in.
     * See <https://github.com/joyent/node-docker-registry-client/pull/6> for
     * an example of the latter.
     *
     * This attempts to reproduce the logic of "docker.git:registry/auth.go#loginV2"
     *
     * @param opts {Object} Optional.
     *      - opts.pingRes {Object} Optional. The response object from an earlier
     *        `ping()` call. This can be used to save re-pinging.
     *      - opts.scope {String} Optional. Scope to use in the auth Bearer token.
     *
     * Side-effects:
     * - On success, all of `this._loggedIn*`, `this._authInfo`, and
     *   `this._headers.authorization` are set.
     */
    async login(opts: {
        pingRes?: DockerResponse;
        scope?: string;
    } = {}) {
        var scope = opts.scope || _makeAuthScope('repository', this.repo.remoteName!, this.scopes);

        if (this._loggedIn && this._loggedInScope === scope) {
            return;
        }

        const authInfo = await this.performLogin({
            pingRes: opts.pingRes,
            scope: scope,
        });
        this._loggedIn = true;
        this._loggedInScope = scope;
        this._authInfo = authInfo;
        _setAuthHeaderFromAuthInfo(this._headers, authInfo);
        // this.log.trace({err: err, loggedIn: this._loggedIn}, 'login: done');
    };

    /**
     * Determine if this registry supports the v2 API.
     * https://docs.docker.com/registry/spec/api/#api-version-check
     *
     * Note that, at least, currently we are presuming things are fine with a 401.
     * I.e. defering auth to later calls.
     *
     * @param cb {Function} `function (err, supportsV2)`
     *      where `supportsV2` is a boolean indicating if V2 API is supported.
     */
    async supportsV2() {
        let res;
        try {
            res = await this.ping();
        } catch (err) {
            if (err.resp) return false;
            throw err;
        }

        var header = res.headers.get('docker-distribution-api-version');
        if (header) {
            /*
                * Space- or comma-separated. The latter occurs if there are
                * two separate headers.
                */
            var versions = header.split(/[\s,]+/g);
            if (versions.includes('registry/2.0')) {
                return true;
            }
        }
        return [200, 401].includes(res.status);
    };


    async listTags(): Promise<TagList> {
        await this.login();
        const res = await this._api.request({
            method: 'GET',
            path: `/v2/${encodeURI(this.repo.remoteName!)}/tags/list`,
            headers: this._headers,
            redirect: 'follow',
        });
        return await res.dockerJson();
    };

    /*
    * Get an image manifest. `ref` is either a tag or a digest.
    * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
    *
    *   client.getManifest({ref: <tag or digest>}, function (err, manifest, res,
    *      manifestStr) {
    *      // Use `manifest` and digest is `res.headers['docker-content-digest']`.
    *      // Note that docker-content-digest header can be undefined, so if you
    *      // need a manifest digest, use the `digestFromManifestStr` function.
    *   });
    */
    async getManifest(opts: {
        ref: string;
        acceptManifestLists?: boolean;
        acceptOCIManifests?: boolean;
        followRedirects?: boolean;
    }) {
        var acceptOCIManifests = opts.acceptOCIManifests
            ?? this.acceptOCIManifests;
        var acceptManifestLists = opts.acceptManifestLists
            ?? this.acceptManifestLists;

        await this.login();
        var headers = new Headers(this._headers);
        headers.append('accept', MEDIATYPE_MANIFEST_V2);
        if (acceptManifestLists) {
            headers.append('accept', MEDIATYPE_MANIFEST_LIST_V2);
        }
        if (acceptOCIManifests) {
            headers.append('accept', MEDIATYPE_OCI_MANIFEST_V1);
            if (acceptManifestLists) {
                headers.append('accept', MEDIATYPE_OCI_MANIFEST_INDEX_V1);
            }
        }

        const resp = await this._api.request({
            method: 'GET',
            path: `/v2/${encodeURI(this.repo.remoteName ?? '')}/manifests/${encodeURI(opts.ref)}`,
            headers: headers,
            redirect: opts.followRedirects == false ? 'manual' : 'follow',
            expectStatus: [200, 401],
        });
        if (resp.status === 401) {
            var errMsg = _getRegistryErrorMessage(await resp.dockerJson());
            throw await resp.dockerThrowable(`Manifest ${JSON.stringify(opts.ref)} Not Found: ${errMsg}`);
        }

        const manifest: Manifest = await resp.dockerJson();

        if (manifest.schemaVersion as number === 1) {
            throw new Error(`schemaVersion 1 is not supported by /x/docker_registry_client.`);
        }

        // Verify the manifest contents.
        var layers: Array<unknown> | undefined;
        const mediaType = manifest.mediaType || resp.headers.get('content-type');
        if (mediaType === MEDIATYPE_MANIFEST_LIST_V2
                || mediaType === MEDIATYPE_OCI_MANIFEST_INDEX_V1) {
            layers = (manifest as ManifestOCIIndex).manifests;
        } else {
            layers = (manifest as ManifestOCI).layers;
        }
        if (!layers || layers.length === 0) {
            throw new e.InvalidContentError(
                `no layers or manifests in ${this.repo.localName}:${opts.ref} manifest`);
        }

        return {resp, manifest};
    };


    async deleteManifest(opts: {
        ref: string;
    }) {
        await this.login();
        const resp = await this._api.request({
            method: 'DELETE',
            path: `/v2/${encodeURI(this.repo.remoteName ?? '')}/manifests/${encodeURI(opts.ref)}`,
            headers: this._headers,
            expectStatus: [200, 202],
        });
        await resp.dockerJson(); // GCR gives { errors: [] }
    };


    /**
     * Makes a http request to the given url, following any redirects, then fires
     * the callback(err, req, responses) with the result.
     *
     * Note that 'responses' is an *array* of restify http response objects, with
     * the last response being at the end of the array. When there is more than
     * one response, it means a redirect has been followed.
     */
    async _makeHttpRequest(opts: {
        method: string;
        path: string;
        // url: string;
        headers?: Headers,
        followRedirects?: boolean;
        maxRedirects?: number;
    }) {
        const followRedirects = opts.followRedirects ?? true;
        const maxRedirects = opts.maxRedirects ?? 3;
        let numRedirs = 0;
        let req = {
            client: this._api,
            path: opts.path,
            headers: opts.headers,
        };
        const ress = new Array<DockerResponse>();

        while (numRedirs < maxRedirects) {
            numRedirs += 1;

            req.client.accept = ''; // TODO: do better
            const resp = await req.client.request({
                method: opts.method,
                path: req.path,
                headers: req.headers,
                redirect: 'manual',
                expectStatus: [200, 302, 307],
            });
            ress.push(resp);

            if (!followRedirects) return ress;
            if (!(resp.status === 302 || resp.status === 307)) return ress;

            const location = resp.headers.get('location');
            if (!location) return ress;

            const loc = new URL(location, new URL(req.path, req.client.url));
            // this.log.trace({numRedirs: numRedirs, loc: loc}, 'got redir response');
            req = {
                client: new DockerJsonClient({
                    url: loc.origin,
                    ...this._commonHttpClientOpts,
                }),
                path: loc.href.slice(loc.origin.length),
                headers: new Headers,
            };

            // consume the redirect's body since probably no one else will
            await resp.dockerBody();
        }

        throw new e.TooManyRedirectsError(`maximum number of redirects (${maxRedirects}) hit`);
    };


    async _headOrGetBlob(opts: {
        method: string;
        digest: string;
    }) {
        await this.login();
        return await this._makeHttpRequest({
            method: opts.method,
            path: `/v2/${encodeURI(this.repo.remoteName ?? '')}/blobs/${encodeURI(opts.digest)}`,
            headers: this._headers,
        });
    };


    /*
    * Get an image file blob -- just the headers. See `getBlob`.
    *
    * <https://docs.docker.com/registry/spec/api/#get-blob>
    * <https://docs.docker.com/registry/spec/api/#pulling-an-image-manifest>
    *
    * This endpoint can return 3xx redirects. An example first hit to Docker Hub
    * yields this response
    *
    *      HTTP/1.1 307 Temporary Redirect
    *      docker-content-digest: sha256:b15fbeba7181d178e366a5d8e0...
    *      docker-distribution-api-version: registry/2.0
    *      location: https://dseasb33srnrn.cloudfront.net/registry-v2/...
    *      date: Mon, 01 Jun 2015 23:43:55 GMT
    *      content-type: text/plain; charset=utf-8
    *      connection: close
    *      strict-transport-security: max-age=3153600
    *
    * And after resolving redirects, this:
    *
    *      HTTP/1.1 200 OK
    *      Content-Type: application/octet-stream
    *      Content-Length: 2471839
    *      Connection: keep-alive
    *      Date: Mon, 01 Jun 2015 20:23:43 GMT
    *      Last-Modified: Thu, 28 May 2015 23:02:16 GMT
    *      ETag: "f01c599df7404875a0c1740266e74510"
    *      Accept-Ranges: bytes
    *      Server: AmazonS3
    *      Age: 11645
    *      X-Cache: Hit from cloudfront
    *      Via: 1.1 e3799a12d0e2fdaad3586ff902aa529f.cloudfront.net (CloudFront)
    *      X-Amz-Cf-Id: 8EUekYdb8qGK48Xm0kmiYi1GaLFHbcv5L8fZPOUWWuB5zQfr72Qdfg==
    *
    * A client will typically want to follow redirects, so by default we
    * follow redirects and return a responses. If needed a `opts.noFollow=true`
    * could be implemented.
    *
    *      cb(err, ress)   // `ress` is the plural of `res` for "response"
    *
    * Interesting headers:
    * - `ress[0].headers['docker-content-digest']` is the digest of the
    *   content to be downloaded
    * - `ress[-1].headers['content-length']` is the number of bytes to download
    * - `ress[-1].headers[*]` as appropriate for HTTP caching, range gets, etc.
    */
    async headBlob(opts: {
        digest: string;
    }) {
        const resp = await this._headOrGetBlob({
            method: 'HEAD',
            digest: opts.digest
        });
        // consume the final body - since HEADs don't have meaningful bodies
        await resp.slice(-1)[0].arrayBuffer();
        return resp;
    };


    /**
     * Get a ReadableStream to the given blob.
     * <https://docs.docker.com/registry/spec/api/#get-blob>
     *
     * Possible usage:
     *
     *      const {stream} = await client.createBlobReadStream({digest: DIGEST});
     *      const file = await Deno.create(`/var/tmp/blob-${DIGEST}.file`);
     *      for await (const chunk of stream) {
     *          await Deno.writeAll(chunk, myFile);
     *      }
     *      file.close();
     *      console.log('Done downloading blob', DIGEST);

     *
     * See "examples/v2/downloadBlob.ts" for a more complete example.
     * This stream will verify 'Docker-Content-Digest' and 'Content-Length'
     * response headers, calling back with `BadDigestError` if they don't verify.
     *
     * Note: While the spec says the registry response will include the
     * Docker-Content-Digest and Content-Length headers, there is a suggestion that
     * this was added to the spec in rev "a", see
     * <https://docs.docker.com/registry/spec/api/#changes>. Also, if I read it
     * correctly, it looks like Docker's own registry client code doesn't
     * require those headers:
     *     // JSSTYLED
     *     https://github.com/docker/distribution/blob/master/registry/client/repository.go#L220
     * So this implementation won't require them either.
     *
     * @param opts {Object}
     *      - digest {String}
     * @return
     *      The `stream` is a W3C ReadableStream.
     *      `ress` (plural of 'res') is an array of responses
     *      after following redirects. The latest response is where `stream`
     *      came from. The full set of responses are returned mainly because
     *      headers on both the first, e.g. 'Docker-Content-Digest', and last,
     *      e.g. 'Content-Length', might be interesting.
     */
    async createBlobReadStream(opts: {
        digest: string;
    }) {
        const ress = await this._headOrGetBlob({
            method: 'GET',
            digest: opts.digest,
        });
        let stream = ress[ress.length - 1].dockerStream();

        var dcdHeader = ress[0].headers.get('docker-content-digest');
        if (dcdHeader) {
            const dcdInfo = _parseDockerContentDigest(dcdHeader);
            if (dcdInfo.raw !== opts.digest) {
                throw new e.BadDigestError(
                    `Docker-Content-Digest header, ${dcdInfo.raw}, does not match ` +
                    `given digest, ${opts.digest}`);
            }

            stream = stream.pipeThrough(dcdInfo.validationStream);
        } else {
            // stream.log.debug({headers: ress[0].headers},
        }

        return { ress, stream };
    };


    /*
    * Upload an image manifest. `ref` is either a tag or a digest.
    * <https://docs.docker.com/registry/spec/api/#pushing-an-image>
    * <https://github.com/opencontainers/distribution-spec/blob/main/spec.md#pushing-manifests>
    *
    *   client.putManifest({manifest: <string>, ref: <tag or digest>},
    *   function (err, res, digest, location) {
    *      // Digest is `res.headers['docker-content-digest']`.
    *   });
    */
    async putManifest(opts: {
        manifestData: Uint8Array;
        ref: string;
        schemaVersion?: number;
        mediaType?: string;
    }) {
        await this.login({
            scope: _makeAuthScope('repository', this.repo.remoteName!, ['pull', 'push']),
        });

        const mediaType = opts.mediaType ??
            `application/vnd.docker.distribution.manifest.v${opts.schemaVersion ?? 1}+json`

        const response = await this._api.request({
            method: 'PUT',
            path: `/v2/${encodeURI(this.repo.remoteName!)}/manifests/${encodeURIComponent(opts.ref)}`,
            headers: _setAuthHeaderFromAuthInfo(new Headers({
                'content-type': mediaType,
            }), this._authInfo ?? null),
            body: opts.manifestData,
            expectStatus: [201],
        }).catch(cause => Promise.reject(new e.UploadError("Manifest upload failed.", {cause})));

        const digest = response.headers.get('docker-content-digest');
        const location = response.headers.get('location');
        return { digest, location };
    };


    /*
    * Upload a blob. The request stream will be used to
    * complete the upload in a single request.
    *
    * <https://docs.docker.com/registry/spec/api/#starting-an-upload>
    * <https://github.com/opencontainers/distribution-spec/blob/main/spec.md#post-then-put>
    */
    async blobUpload(opts: {
        digest: string;
        stream: ReadableStream<Uint8Array> | Uint8Array;
        contentLength: number;
        contentType?: string;
    }) {
        await this.login({
            scope: _makeAuthScope('repository', this.repo.remoteName!, ['pull', 'push']),
        });

        const sessionResponse = await this._api.request({
            method: 'POST',
            path: `/v2/${encodeURI(this.repo.remoteName!)}/blobs/uploads/`,
            headers: _setAuthHeaderFromAuthInfo(new Headers(), this._authInfo ?? null),
            expectStatus: [202],
        }).catch(cause => Promise.reject(new e.UploadError("Blob upload rejected.", {cause})));
        const uploadUrl = sessionResponse.headers.get('location');
        if (!uploadUrl) throw new e.UploadError(
            'No registry upload location header returned');

        const destinationUrl = new URL(uploadUrl);
        destinationUrl.searchParams.append('digest', opts.digest);
        await this._api.request({
            method: 'PUT',
            path: destinationUrl.toString(),
            headers: _setAuthHeaderFromAuthInfo(new Headers({
                'content-length': `${opts.contentLength}`,
                'content-type': (opts.contentType || 'application/octet-stream'),
            }), this._authInfo ?? null),
            body: opts.stream,
            expectStatus: [201],
        }).catch(cause => Promise.reject(new e.UploadError("Blob upload failed.", {cause})));
    }

}

export function createClient(opts: RegistryClientOpts) {
    return new RegistryClientV2(opts);
}
