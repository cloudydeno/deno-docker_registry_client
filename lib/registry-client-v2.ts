/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Sha256 } from "https://deno.land/std@0.92.0/hash/sha256.ts";

import {
    parseIndex, parseRepo,
    deepObjCopy,
    isLocalhost,
    urlFromIndex,
    DEFAULT_USERAGENT,
} from "./common.ts";
import {
    Manifest,
    RegistryIndex, RegistryImage,
} from "./types.ts";
import { DockerJsonClient, DockerResponse } from "./docker-json-client.ts";
import { Parse_WWW_Authenticate } from "./www-authenticate.ts";

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * Docker Registry API v2 client. See the README for an intro.
 *
 * <https://docs.docker.com/registry/spec/api/>
 */

// var assert = require('assert-plus');
// var base64url = require('base64url');
// var bunyan = require('bunyan');
// var crypto = require('crypto');
// var fmt = require('util').format;
// var jwkToPem = require('jwk-to-pem');
// var mod_jws = require('jws');
// var querystring = require('querystring');
// var restifyClients = require('restify-clients');
// var restifyErrors = require('restify-errors');
// var strsplit = require('strsplit');
// var mod_url = require('url');
// var vasync = require('vasync');

// var common = require('./common');
// var DockerJsonClient = require('./docker-json-client');
// var errors = require('./errors');


// --- Globals

// https://github.com/docker/docker/blob/77da5d8/registry/config_unix.go#L10
var DEFAULT_V2_REGISTRY = 'https://registry-1.docker.io';
var MAX_REGISTRY_ERROR_LENGTH = 10000;

export const MEDIATYPE_MANIFEST_V2
    = 'application/vnd.docker.distribution.manifest.v2+json';
export const MEDIATYPE_MANIFEST_LIST_V2
    = 'application/vnd.docker.distribution.manifest.list.v2+json';


// --- internal support functions


// function _createLogger(log) {
//     assert.optionalObject(log, 'log');

//     if (log) {
//         // TODO avoid this .child if already have the serializers, e.g. for
//         // recursive call.
//         return log.child({
//             serializers: restifyClients.bunyan.serializers
//         });
//     } else {
//         return bunyan.createLogger({
//             name: 'registry',
//             serializers: restifyClients.bunyan.serializers
//         });
//     }
// }


function _basicAuthHeader(username: string, password: string) {
    return 'Basic ' + btoa(username + ':' + password);
}


/*
 * Set the "Authorization" HTTP header into the headers object from the given
 * auth info.
 * - Bearer auth if `token`.
 * - Else, Basic auth if `username`.
 * - Else, if the authorization key exists, then it is removed from headers.
 */
function _setAuthHeaderFromAuthInfo(headers: Headers, authInfo: AuthInfo) {
    if (authInfo.token) {
        headers.set('authorization', 'Bearer ' + authInfo.token);
    } else if (authInfo.username || authInfo.password) {
        headers.set('authorization', _basicAuthHeader(authInfo.username ?? '',
            authInfo.password ?? ''));
    } else {
        headers.delete('authorization');
    }
}

interface AuthInfo {
    type?: string;
    username?: string;
    password?: string;
    token?: string;
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


/**
 * Get an auth token.
 *
 * See: docker/docker.git:registry/token.go
 */
async function _getToken(opts: {
    indexName: string;
    realm: string;
    service?: string;
    scopes?: string[];
    username?: string;
    password?: string;
    // assert.object(opts.log, 'opts.log');
    // assert.optionalObject(opts.agent, 'opts.agent');
    // // assert.optional object or bool(opts.proxy, 'opts.proxy');
    insecure?: boolean;
    userAgent?: string;
}): Promise<string> {
    // - add https:// prefix (or http) if none on 'realm'
    var tokenUrl = opts.realm;
    var match = /^(\w+):\/\//.exec(tokenUrl);
    if (!match) {
        tokenUrl = (opts.insecure ? 'http' : 'https') + '://' + tokenUrl;
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
    if (opts.username) {
        query.set('account', opts.username);
        _setAuthHeaderFromAuthInfo(headers, {
            username: opts.username,
            password: opts.password
        });
    }
    if (query.toString()) {
        tokenUrl += '?' + query.toString();
    }
    // log.trace({tokenUrl: tokenUrl}, '_getToken: url');

    var parsedUrl = new URL(tokenUrl);
    var client = new DockerJsonClient({
        url: parsedUrl.origin,
        // log: log,
        // agent: opts.agent,
        // proxy: opts.proxy,
        rejectUnauthorized: !opts.insecure,
        userAgent: opts.userAgent || DEFAULT_USERAGENT
    });
    const resp = await client.get({
        path: parsedUrl.href.slice(parsedUrl.origin.length),
        headers: headers,
        expectStatus: [200, 401],
    });
    if (resp.status === 401) {
        // Convert *all* 401 errors to use a generic error constructor
        // with a simple error message.
        var errMsg = _getRegistryErrorMessage(await resp.dockerJson());
        throw new Error('Registry 401 - Auth failed: '+errMsg);
    }
    const body = await resp.json();
    if (typeof body.token !== 'string') {
        console.log('auth resp:', body);
        throw new Error('authorization ' +
            'server did not include a token in the response');
    }
    return body.token;
}


/* BEGIN JSSTYLED */
/*
 * Parse out a JWS (JSON Web Signature) from the given Docker manifest
 * endpoint response. This JWS is used for both 'Docker-Content-Digest' header
 * verification and JWS signing verification.
 *
 * This mimicks:
 *      func ParsePrettySignature(content []byte, signatureKey string)
 *          (*JSONSignature, error)
 * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
 *
 * @returns {Object} JWS object with 'payload' and 'signatures' fields.
 * @throws {InvalidContentError} if there is a problem parsing the manifest
 *      body.
 *
 *
 * # Design
 *
 * tl;dr: Per <https://docs.docker.com/registry/spec/api/#digest-header>
 * the payload used for the digest is a little obtuse for the getManifest
 * endpoint: It is the raw JSON body (the raw content because indentation
 * and key order matters) minus the "signatures" key. The "signatures"
 * key is always the last one. The byte offset at which to strip and a
 * suffix to append is included in the JWS "protected" header.
 *
 *
 * A longer explanation:
 *
 * Let's use the following (clipped for clarity) sample getManifest
 * request/response to a Docker v2 Registry API (in this case Docker Hub):
 *
 *     GET /v2/library/alpine/manifests/latest HTTP/1.1
 *     ...
 *
 *     HTTP/1.1 200 OK
 *     docker-content-digest: sha256:08a98db12e...fe0d
 *     ...
 *
 *     {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": [
 *             {
 *                 "blobSum": "sha256:c862d82a67...d58"
 *             }
 *         ],
 *         "history": [
 *             {
 *                 "v1Compatibility": "{\"id\":\"31f6...4492}\n"
 *             }
 *         ],
 *         "signatures": [
 *             {
 *                 "header": {
 *                     "jwk": {
 *                         "crv": "P-256",
 *                         "kid": "OIH7:HQFS:44FK:45VB:3B53:OIAG:TPL4:ATF5:6PNE:MGHN:NHQX:2GE4",
 *                         "kty": "EC",
 *                         "x": "Cu_UyxwLgHzE9rvlYSmvVdqYCXY42E9eNhBb0xNv0SQ",
 *                         "y": "zUsjWJkeKQ5tv7S-hl1Tg71cd-CqnrtiiLxSi6N_yc8"
 *                     },
 *                     "alg": "ES256"
 *                 },
 *                 "signature": "JV1F_gXAsUEp_e2WswSdHjvI0veC-f6EEYuYJZhgIPpN-LQ5-IBSOX7Ayq1gv1m2cjqPy3iXYc2HeYgCQTxM-Q",
 *                 "protected": "eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ"
 *             }
 *         ]
 *     }
 *
 *
 * We will be talking about specs from the IETF JavaScript Object Signing
 * and Encryption (JOSE) working group
 * <https://datatracker.ietf.org/wg/jose/documents/>. The relevant ones
 * with Docker registry v2 (a.k.a. docker/distribution) are:
 *
 * 1. JSON Web Signature (JWS): https://tools.ietf.org/html/rfc7515
 * 2. JSON Web Key (JWK): https://tools.ietf.org/html/rfc7517
 *
 *
 * Docker calls the "signatures" value the "JWS", a JSON Web Signature.
 * That's mostly accurate. A JWS, using the JSON serialization that
 * Docker is using, looks like:
 *
 *      {
 *          "payload": "<base64url-encoded payload bytes>",
 *          "signatures": [
 *              {
 *                  "signature": "<base64url-encoded signature>",
 *                  // One or both of "protected" and "header" must be
 *                  // included, and an "alg" key (the signing algoritm)
 *                  // must be in one of them.
 *                  "protected": "<base64url-encoded header key/value pairs
 *                      included in the signature>",
 *                  "header": {
 *                      <key/value pairs *not* included in the signature>
 *                   }
 *              }
 *          ]
 *      }
 *
 * (I'm eliding some details: If there is only one signature, then the
 * signature/protected/et al fields can be raised to the top-level. There
 * is a "compact" serialization that we don't need to worry about,
 * other than most node.js JWS modules don't directly support the JSON
 * serialization. There are other optional signature fields.)
 *
 * I said "mostly accurate", because the "payload" is missing. Docker
 * flips the JWS inside out, so that the "signatures" are include *in
 * the payload*. The "protected" header provides some data needed to
 * tease the signing payload out of the HTTP response body. Using our
 * example:
 *
 *      $ echo eyJmb3JtYXRMZW5ndGgiOjE2NzUsImZvcm1hdFRhaWwiOiJDbjAiLCJ0aW1lIjoiMjAxNS0wOS0xMFQyMzoyODowNloifQ | ./node_modules/.bin/base64url --decode
 *      {"formatLength":1675,"formatTail":"Cn0","time":"2015-09-10T23:28:06Z"}
 *
 * Here "formatLength" is a byte count into the response body to extract
 * and "formatTail" is a base64url-encoded suffix to append to that. In
 * practice the "formatLength" is up to comma before the "signatures" key
 * and "formatLength" is:
 *
 *      > base64url.decode('Cn0')
 *      '\n}'
 *
 * Meaning the signing payload is typically the equivalent of
 * `delete body["signatures"]`:
 *
 *      {
 *         "schemaVersion": 1,
 *         "name": "library/alpine",
 *         "tag": "latest",
 *         "architecture": "amd64",
 *         "fsLayers": ...,
 *         "history": ...
 *      }
 *
 * However, whitespace is significant because we are just signing bytes,
 * so the raw response body must be manipulated. An odd factoid is that
 * docker/libtrust seems to default to 3-space indentation:
 * <https://github.com/docker/libtrust/blob/9cbd2a1374f46905c68a4eb3694a130610adc62a/jsonsign.go#L450>
 * Perhaps to avoid people getting lucky.
 *
 */
/* END JSSTYLED */
// function _jwsFromManifest(manifest: unknown, body: Uint8Array) {
//     var formatLength;
//     var formatTail;
//     var jws = {
//         signatures: []
//     };

//     for (var i = 0; i < manifest.signatures.length; i++) {
//         var sig = manifest.signatures[i];

//         try {
//             var protectedHeader = JSON.parse(
//                 base64url.decode(sig['protected']));
//         } catch (protectedErr) {
//             throw new restifyErrors.InvalidContentError(protectedErr, fmt(
//                 'could not parse manifest "signatures[%d].protected": %j',
//                 i, sig['protected']));
//         }
//         if (isNaN(protectedHeader.formatLength)) {
//             throw new restifyErrors.InvalidContentError(fmt(
//                 'invalid "formatLength" in "signatures[%d].protected": %j',
//                 i, protectedHeader.formatLength));
//         } else if (formatLength === undefined) {
//             formatLength = protectedHeader.formatLength;
//         } else if (protectedHeader.formatLength !== formatLength) {
//             throw new restifyErrors.InvalidContentError(fmt(
//                 'conflicting "formatLength" in "signatures[%d].protected": %j',
//                 i, protectedHeader.formatLength));
//         }

//         if (!protectedHeader.formatTail ||
//             typeof (protectedHeader.formatTail) !== 'string')
//         {
//             throw new restifyErrors.InvalidContentError(fmt(
//                 'missing "formatTail" in "signatures[%d].protected"', i));
//         }
//         var formatTail_ = base64url.decode(protectedHeader.formatTail);
//         if (formatTail === undefined) {
//             formatTail = formatTail_;
//         } else if (formatTail_ !== formatTail) {
//             throw new restifyErrors.InvalidContentError(fmt(
//                 'conflicting "formatTail" in "signatures[%d].protected": %j',
//                 i, formatTail_));
//         }

//         var jwsSig = {
//             header: {
//                 alg: sig.header.alg,
//                 chain: sig.header.chain
//             },
//             signature: sig.signature,
//             'protected': sig['protected']
//         };
//         if (sig.header.jwk) {
//             try {
//                 jwsSig.header.jwk = jwkToPem(sig.header.jwk);
//             } catch (jwkErr) {
//                 throw new restifyErrors.InvalidContentError(jwkErr, fmt(
//                     'error in "signatures[%d].header.jwk": %s',
//                     i, jwkErr.message));
//             }
//         }
//         jws.signatures.push(jwsSig);
//     }

//     jws.payload = Buffer.concat([
//         body.slice(0, formatLength),
//         new Buffer(formatTail)
//     ]);

//     return jws;
// }


// /*
//  * Parse the 'Docker-Content-Digest' header.
//  *
//  * @throws {BadDigestError} if the value is missing or malformed
//  * @returns ...
//  */
// function _parseDockerContentDigest(dcd) {
//     if (!dcd) {
//         throw new restifyErrors.BadDigestError(
//             'missing "Docker-Content-Digest" header');
//     }

//     // E.g. docker-content-digest: sha256:887f7ecfd0bda3...
//     var parts = strsplit(dcd, ':', 2);
//     if (parts.length !== 2) {
//         throw new restifyErrors.BadDigestError(
//             'could not parse "Docker-Content-Digest" header: ' + dcd);
//     }

//     var hash;
//     try {
//         hash = crypto.createHash(parts[0]);
//     } catch (hashErr) {
//         throw new restifyErrors.BadDigestError(hashErr, fmt(
//             '"Docker-Content-Digest" header error: %s: %s',
//             hashErr.message, dcd));
//     }
//     var expectedDigest = parts[1];

//     return {
//         raw: dcd,
//         hash: hash,
//         algorithm: parts[0],
//         expectedDigest: expectedDigest
//     };
// }

// /*
//  * Verify the 'Docker-Content-Digest' header for a getManifest response.
//  *
//  * @throws {BadDigestError} if the digest doesn't check out.
//  */
// function _verifyManifestDockerContentDigest(res, jws) {
//     var dcdInfo = _parseDockerContentDigest(
//         res.headers['docker-content-digest']);

//     dcdInfo.hash.update(jws.payload);
//     var digest = dcdInfo.hash.digest('hex');
//     if (dcdInfo.expectedDigest !== digest) {
//         res.log.trace({expectedDigest: dcdInfo.expectedDigest,
//             header: dcdInfo.raw, digest: digest},
//             'Docker-Content-Digest failure');
//         throw new restifyErrors.BadDigestError('Docker-Content-Digest');
//     }
// }


// /*
//  * Verify a manifest JWS (JSON Web Signature)
//  *
//  * This mimicks
//  *      func Verify(sm *SignedManifest) ([]libtrust.PublicKey, error)
//  * in "docker/vendor/src/github.com/docker/distribution/manifest/verify.go"
//  * which calls
//  *      func (js *JSONSignature) Verify() ([]PublicKey, error)
//  * in "docker/vendor/src/github.com/docker/libtrust/jsonsign.go"
//  *
//  * TODO: find an example with `signatures.*.header.chain` to test that path
//  *
//  * @param jws {Object} A JWS object parsed from `_jwsFromManifest`.
//  * @throws {errors.ManifestVerificationError} if there is a problem.
//  */
// function _verifyJws(jws) {
//     var encodedPayload = base64url(jws.payload);

//     /*
//      * Disallow the "none" algorithm because while the `jws` module might have
//      * a guard against
//      *      // JSSTYLED
//      *      https://auth0.com/blog/2015/03/31/critical-vulnerabilities-in-json-web-token-libraries/
//      * why bother allowing it?
//      */
//     var disallowedAlgs = ['none'];

//     for (var i = 0; i < jws.signatures.length; i++) {
//         var jwsSig = jws.signatures[i];
//         var alg = jwsSig.header.alg;
//         if (disallowedAlgs.indexOf(alg) !== -1) {
//             throw new errors.ManifestVerificationError(
//                 {jws: jws, i: i}, 'disallowed JWS signature algorithm:', alg);
//         }

//         // TODO: Find Docker manifest example using 'header.chain'
//         // and implement this. See "jsonsign.go#Verify".
//         if (jwsSig.header.chain) {
//             throw new errors.InternalError({jws: jws, i: i},
//                 'JWS verification with a cert "chain" is not implemented: %j',
//                 jwsSig.header.chain);
//         }

//         // `mod_jws.verify` takes the JWS compact representation.
//         var jwsCompact = jwsSig['protected'] + '.' + encodedPayload +
//             '.' + jwsSig.signature;
//         var verified = mod_jws.verify(jwsCompact, alg, jwsSig.header.jwk);
//         if (!verified) {
//             throw new errors.ManifestVerificationError(
//                 {jws: jws, i: i}, 'JWS signature %d failed verification', i);
//         }
//     }
// }


// --- other exports

/**
 * Ping the base URL.
 * See: <https://docs.docker.com/registry/spec/api/#base>
 *
 * @param opts {Object} Required members are listed first.
 *      - opts.index {String|Object} Required. One of an index *name* (e.g.
 *        "docker.io", "quay.io") that `parseIndex` will handle, an index
 *        *url* (e.g. the default from `docker login` is
 *        'https://index.docker.io/v1/'), or an index *object* as returned by
 *        `parseIndex`. For backward compatibility, `opts.indexName` may be
 *        used instead of `opts.index`.
 *      --
 *      - opts.log {Bunyan Logger} Optional.
 *      --
 *      TODO: document other options
 * @param cb {Function} `function (err, body, res, req)`
 *      `err` is set if there was a problem getting a ping response. `res` is
 *      the response object. Use `res.statusCode` to infer information:
 *          404     This registry URL does not support the v2 API.
 *          401     Authentication is required (or failed). Use the
 *                  WWW-Authenticate header for the appropriate auth method.
 *                  This `res` can be passed to `login()` to handle
 *                  authenticating.
 *          200     Successful authentication. The response body is `body`
 *                  if wanted.
 */
export async function ping(opts: {
    index?: string | RegistryIndex;
    indexName?: string;
    // log
    insecure?: boolean;
    // rejectUnauthorized?: boolean;
    userAgent?: string;
    // agent
}) {
    var index = opts.index || opts.indexName;
    if (typeof (index) === 'string') {
        index = parseIndex(index);
    } else if (!index) throw new Error(`index is required`);

    // var log = _createLogger(opts.log);
    // log.trace({index: index, scope: opts.scope, insecure: opts.insecure},
    //     'ping');

    /*
     * We have to special case usage of the "official" docker.io to
     *      https://registry-1.docker.io
     * because:
     *      GET /v2/ HTTP/1.1
     *      Host: index.docker.io
     *
     *      HTTP/1.1 301 Moved Permanently
     *      location: https://registry.hub.docker.com/v2/
     * and:
     *      $ curl -i https://registry.hub.docker.com/v2/
     *      HTTP/1.1 404 NOT FOUND
     */
    var registryUrl;
    if (index.official) {
        registryUrl = DEFAULT_V2_REGISTRY;
    } else {
        registryUrl = urlFromIndex(index);
    }

    /*
     * We allow either opts.rejectUnauthorized (for passed in http client
     * options where `insecure` -> `rejectUnauthorized` translation has
     * already been done) or opts.insecure (this module's chosen name
     * for this thing).
     */
    // var rejectUnauthorized;
    // if (opts.insecure !== undefined && opts.rejectUnauthorized !== undefined) {
    //     throw new Error(
    //         'cannot set both opts.insecure and opts.rejectUnauthorized');
    // } else if (opts.insecure !== undefined) {
    //     rejectUnauthorized = !opts.insecure;
    // } else if (opts.rejectUnauthorized !== undefined) {
    //     rejectUnauthorized = opts.rejectUnauthorized;
    // }

    var client = new DockerJsonClient({
        url: registryUrl,
        // log: opts.log,
        userAgent: opts.userAgent || DEFAULT_USERAGENT,
        // rejectUnauthorized: rejectUnauthorized,
        // agent: opts.agent,
        // proxy: opts.proxy
    });

    const resp = await client.get({
        path: '/v2/',
        expectStatus: [200, 401, 404],
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
 *      - opts.index {String|Object} Required. One of an index *name* (e.g.
 *        "docker.io", "quay.io") that `parseIndex` will handle, an index
 *        *url* (e.g. the default from `docker login` is
 *        'https://index.docker.io/v1/'), or an index *object* as returned by
 *        `parseIndex`. For backward compatibility, `opts.indexName` may be
 *        used instead of `opts.index`.
 *      - opts.username {String} Optional. Username and password are optional
 *        to allow `RegistryClientV2` to use `login` in the common case when
 *        there may or may not be auth required.
 *      - opts.password {String} Optional, but required if `opts.username` is
 *        provided.
 *      - opts.scope {String} Optional. A scope string passed in for
 *        bearer/token auth. If this is just a login request where the token
 *        won't be used, then the empty string (the default) is sufficient.
 *        // JSSTYLED
 *        See <https://github.com/docker/distribution/blob/master/docs/spec/auth/token.md#requesting-a-token>
 *      - opts.pingRes {Object} Optional. The response object from an earlier
 *        `ping()` call. This can be used to save re-pinging.
 *      - opts.pingErr {Object} Required if `pingRes` given. The error
 *        object for `pingRes`.
 *      ...
 * @param cb {Function} `function (err, result)`
 *      On success, `result` is an object with:
 *          status      a string description of the login result status
 *          authInfo    an object with authentication info, examples:
 *                          {type: 'basic', username: '...', password: '...'}
 *                          {type: 'bearer', token: '...'}
 *                      which can be the empty object when no auth is needed:
 *                          {}
 */
export async function login(opts: {
    index?: string | RegistryIndex;
    indexName?: string;
    username?: string;
    password?: string;
    scope?: string;
    pingRes?: Response;
    // log
    insecure?: boolean;
    // rejectUnauthorized?: boolean;
    userAgent?: string;
    // agent
}) {
    let index = opts.index || opts.indexName;
    if (typeof (index) === 'string') {
        index = parseIndex(index);
    } else if (!index) throw new Error(`index is required`);

    // let log = _createLogger(opts.log);
    // log.trace({index: index, username: opts.username,
    //     password: (opts.password ? '(censored)' : '(none)'),
    //     scope: opts.scope, insecure: opts.insecure}, 'login');

    let scope = opts.scope || '';
    let authInfo: AuthInfo;

    let chalHeader = opts.pingRes?.headers.get('www-authenticate');
    if (!chalHeader) {
        const res = await ping(opts);
        if (res.status === 200) {
            // No authorization is necessary.
            return {
                status: "No authorization is necessary.",
                authInfo: {},
            };
        } else if (res.status === 401) {
            chalHeader = res.headers.get('www-authenticate');

            // // DOCKER-627 hack for quay.io
            // if (!chalHeader && index.name === 'quay.io') {
            //     /* JSSTYLED */
            //     chalHeader = 'Bearer realm="https://quay.io/v2/auth",service="quay.io"';
            // }

        } else throw new Error(`HTTP ${res.status} from ping endpoint`);
    };
    if (!chalHeader) throw new Error(
        'missing WWW-Authenticate header in 401 ' +
        'response to "GET /v2/" (see ' +
        /* JSSTYLED */
        'https://docs.docker.com/registry/spec/api/#api-version-check)');

    const authChallenge = _parseWWWAuthenticate(chalHeader);

    if (authChallenge.scheme.toLowerCase() === 'basic') {
        authInfo = {
            type: 'basic',
            username: opts.username,
            password: opts.password
        };

    } else if (authChallenge.scheme.toLowerCase() === 'bearer') {
            // log.debug({challenge: ctx.authChallenge},
            //     'login: get Bearer auth token');

        authInfo = {
            type: 'bearer',
            token: await _getToken({
                indexName: index.name,
                realm: authChallenge.parms.realm,
                service: authChallenge.parms.service,
                scopes: scope ? [scope] : [],
                username: opts.username,
                password: opts.password,
                // HTTP client opts:
                // log: log,
                // agent: opts.agent,
                // proxy: opts.proxy,
                userAgent: opts.userAgent,
                insecure: opts.insecure
            }),
        };

    } else throw new Error(
        `unsupported auth scheme: "${authChallenge.scheme}"`);

    // log.trace({err: err, success: !err}, 'login: done');
    return {
        status: 'Login Succeeded',
        authInfo: authInfo,
    };
}


/**
 * Calculate the 'Docker-Content-Digest' header for the given manifest.
 *
 * @returns {String} The docker digest string.
 * @throws {InvalidContentError} if there is a problem parsing the manifest.
 */
// export function digestFromManifestStr(manifestStr: string): string {
//     var hash = new Sha256();
//     var digestPrefix = 'sha256:';

//     var manifest;
//     try {
//         manifest = JSON.parse(manifestStr);
//     } catch (err) {
//         throw new Error(`could not parse manifest: ${err.message}\n${manifestStr}`);
//     }
//     if (manifest.schemaVersion === 1) {
//         try {
//             var manifestBuffer = new TextEncoder().encode(manifestStr);
//             var jws = _jwsFromManifest(manifest, manifestBuffer);
//             hash.update(jws.payload, 'binary');
//             return digestPrefix + hash.digest('hex');
//         } catch (verifyErr) {
//             if (!(verifyErr instanceof restifyErrors.InvalidContentError)) {
//                 throw verifyErr;
//             }
//             // Couldn't parse (or doesn't have) the signatures section,
//             // fall through.
//         }
//     }
//     hash.update(manifestStr);
//     return digestPrefix + hash.digest('hex');
// }


interface RegistryClientV2Opts {
    name?: string; // mutually exclusive with repo
    repo?: RegistryImage;
    // log
    username?: string;
    password?: string;
    token?: string; // for bearer auth
    insecure?: boolean;
    scheme?: string;
    acceptManifestLists?: boolean;
    maxSchemaVersion?: number;
    userAgent?: string;
    scopes?: string[];
};


// --- RegistryClientV2
export class RegistryClientV2 {
    insecure: boolean;
    repo: RegistryImage;
    acceptManifestLists: boolean;
    maxSchemaVersion: number;
    username?: string;
    password?: string;
    scopes: string[];
    private _loggedIn: boolean;
    private _loggedInScope?: string | null;
    private _authInfo?: AuthInfo | null;
    private _headers: Headers;
    private _url: string;
    // private _clientsToClose: never[];
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
    constructor(opts: RegistryClientV2Opts) {
        this.insecure = Boolean(opts.insecure);
        if (opts.repo) {
            this.repo = deepObjCopy(opts.repo);
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

        this.acceptManifestLists = opts.acceptManifestLists || false;
        this.maxSchemaVersion = opts.maxSchemaVersion || 1;
        this.username = opts.username;
        this.password = opts.password;
        this.scopes = opts.scopes ?? ['pull'];
        this._loggedIn = false;
        this._loggedInScope = null; // Keeps track of the login type.
        this._authInfo = null;
        this._headers = new Headers();

        _setAuthHeaderFromAuthInfo(this._headers, {
            token: opts.token,
            username: opts.username,
            password: opts.password
        });

        // XXX relevant for v2?
        //this._cookieJar = new tough.CookieJar();

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

//     Object.defineProperty(this, '_httpapi', {
//         get: function () {
//             if (this.__httpapi === undefined) {
//                 this.__httpapi = new restifyClients.HttpClient(common.objMerge({
//                     url: this._url
//                 }, this._commonHttpClientOpts));
//                 this._clientsToClose.push(this.__httpapi);
//             }
//             return this.__httpapi;
//         }
//     });


    version = 2;

    /**
     * Ping the base URL.
     * https://docs.docker.com/registry/spec/api/#base
     */
    ping() {
        return ping({
            index: this.repo.index,
            // username: this.username,
            // password: this.password,
            // authInfo: this._authInfo,
            ...this._commonHttpClientOpts,
        });
    };


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
     *      - opts.pingErr {Object} Required if `pingRes` given. The error
     *        object for `pingRes`.
     *      - opts.scope {String} Optional. Scope to use in the auth Bearer token.
     * @param cb {Function} `function (err)`
     *
     * Side-effects:
     * - On success, all of `this._loggedIn*`, `this._authInfo`, and
     *   `this._headers.authorization` are set.
     */
    async login(opts: {
        pingRes?: Response;
        scope?: string;
    } = {}) {
        var scope = opts.scope || _makeAuthScope('repository', this.repo.remoteName!, this.scopes);

        if (this._loggedIn && this._loggedInScope === scope) {
            return;
        }

        const result = await login({
            index: this.repo.index,
            username: this.username,
            password: this.password,
            pingRes: opts.pingRes,
            scope: scope,
            ...this._commonHttpClientOpts,
        });
        this._loggedIn = true;
        this._loggedInScope = scope;
        this._authInfo = result.authInfo;
        _setAuthHeaderFromAuthInfo(this._headers, this._authInfo);
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
                * two separate headers, e.g.:
                *      $ curl -i https://registry.example.com/v2/
                *      HTTP/1.1 200 OK
                *      ...
                *      Docker-Distribution-Api-Version: registry/2.0
                *      ...
                *      Docker-Distribution-Api-Version: \
                */
            // JSSTYLED
            var versions = header.split(/[\s,]+/g);
            if (versions.indexOf('registry/2.0') !== -1) {
                return true;
            }
        }
        return [200, 401].includes(res.status);
    };


    async listTags(): Promise<{
        name: string;
        tags: string[];
        // these seem GCR specific
        child?: string[];
        manifest?: Record<string, {
            imageSizeBytes: string;
            layerId?: string;
            mediaType: string;
            tag: string[];
            timeCreatedMs: string;
            timeUploadedMs: string;
        }>;
    }> {
        await this.login();
        const res = await this._api.get({
            path: `/v2/${encodeURI(this.repo.remoteName!)}/tags/list`,
            headers: this._headers,
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
        maxSchemaVersion?: number;
        followRedirects?: boolean;
    }) {
        var acceptManifestLists = opts.acceptManifestLists
            ?? this.acceptManifestLists;
        var maxSchemaVersion = opts.maxSchemaVersion
            ?? this.maxSchemaVersion;

        await this.login();
        var headers = new Headers(this._headers);
        if (maxSchemaVersion === 2) {
            const accept = this._headers.get('accept')?.split(', ') ?? [];
            accept.push(MEDIATYPE_MANIFEST_V2);
            if (acceptManifestLists) {
                accept.push(MEDIATYPE_MANIFEST_LIST_V2);
            }
            headers.set('accept', accept.join(', '));
        }

        const resp = await this._api.get({
            path: `/v2/${encodeURI(this.repo.remoteName ?? '')}/manifests/${encodeURI(opts.ref)}`,
            headers: headers,
            redirect: opts.followRedirects == false ? 'manual' : 'follow',
            expectStatus: opts.followRedirects == false ? [200, 301,302,307] : [200],
        }).catch(err => {
            if (err.resp?.status === 401) {
                // Convert into a 404 error.
                // If we get an Unauthorized error here, it actually
                // means the repo does not exist, otherwise we should
                // have received an unauthorized error during the
                // doLogin step and this code path would not be taken.
                var errMsg = _getRegistryErrorMessage(err);
                throw new Error(`Docker registry 401 Not Found: ${errMsg}`);
            }
            throw err;
        });

        if (resp.status > 300 && resp.status < 400) {
            return {resp};
        }

        const manifest = await resp.dockerJson() as Manifest;

        if (manifest.schemaVersion === 1) {
            // TODO
            // var jws = _jwsFromManifest(manifest, body);
            // // Some v2 registries (Amazon ECR) do not provide the
            // // 'docker-content-digest' header.
            // if (resp.headers.has('docker-content-digest')) {
            //     _verifyManifestDockerContentDigest(resp, jws);
            // } else {
            //     // this.log.debug({headers: resp.headers},
            //     //     'no Docker-Content-Digest header on ' +
            //     //     'getManifest response');
            // }
            // _verifyJws(jws);
        }

        if (manifest.schemaVersion > maxSchemaVersion) {
            throw new Error(
                `unsupported schema version ${manifest.schemaVersion
                } in ${this.repo.localName}:${opts.ref} manifest`);
        }

        // Verify the manifest contents.
        if (manifest.mediaType === MEDIATYPE_MANIFEST_LIST_V2) {
            if (!Array.isArray(manifest.manifests) ||
                    manifest.manifests.length === 0) {
                throw new Error(
                    `no manifests in ${this.repo.localName}:${opts.ref} manifest list`);
            }
        } else {
            var layers: Array<unknown> | undefined = manifest.fsLayers;
            if (manifest.schemaVersion === 1) {
                if (layers!.length !== manifest.history!.length) {
                    throw new Error(
                        'history length not equal to layers length in '
                        + `${this.repo.localName}:${opts.ref} manifest`);
                }
            } else if (manifest.schemaVersion === 2) {
                layers = manifest.layers;
            }
            if (!layers || layers.length === 0) {
                throw new Error(
                    `no layers in ${this.repo.localName}:${opts.ref} manifest`);
            }
        }

        // TODO: `verifyTrustedKeys` from
        // docker/graph/pull_v2.go#validateManifest()
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

        throw new Error(`maximum number of redirects (${maxRedirects}) hit`);
    };

// /**
//  * Makes a http request to the given url, following any redirects, then parses
//  * the (JSON) response and fires the callback(err, req, res, obj, body) with
//  * the result. Note that 'obj' is the parsed JSON response object, 'body' is
//  * the raw response body string.
//  */
// _makeJsonRequest(opts, cb) {
//     var this = this;
//     assert.object(opts, 'opts');
//     assert.func(cb, 'cb');

//     this._makeHttpRequest(opts, function (err, req, responses) {
//         var res = responses ? responses[responses.length - 1] : null;
//         if (err) {
//             cb(err, req, res);
//             return;
//         }
//         // Parse the response body using the JSON client parser.
//         var parseFn = DockerJsonClient.prototype.parse.call(this._api, req, cb);
//         parseFn(err, res);
//         // Release the bulls!
//         res.resume();
//     });
// };

    async _headOrGetBlob(opts: {
        method: string;
        digest: string;
    }) {
        await this.login();
        return await this._makeHttpRequest({
            method: opts.method,
            // url: this._url,
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


// /**
//  * Get a *paused* readable stream to the given blob.
//  * <https://docs.docker.com/registry/spec/api/#get-blob>
//  *
//  * Possible usage:
//  *
//  *      client.createBlobReadStream({digest: DIGEST}, function (err, stream) {
//  *          var fout = fs.createWriteStream('/var/tmp/blob-%s.file', DIGEST);
//  *          fout.on('finish', function () {
//  *              console.log('Done downloading blob', DIGEST);
//  *          });
//  *          stream.pipe(fout);
//  *          stream.resume();
//  *      });
//  *
//  * See "examples/v2/downloadBlob.js" for a more complete example.
//  * This stream will verify 'Docker-Content-Digest' and 'Content-Length'
//  * response headers, calling back with `BadDigestError` if they don't verify.
//  *
//  * Note: While the spec says the registry response will include the
//  * Docker-Content-Digest and Content-Length headers, there is a suggestion that
//  * this was added to the spec in rev "a", see
//  * <https://docs.docker.com/registry/spec/api/#changes>. Also, if I read it
//  * correctly, it looks like Docker's own registry client code doesn't
//  * require those headers:
//  *     // JSSTYLED
//  *     https://github.com/docker/distribution/blob/master/registry/client/repository.go#L220
//  * So this implementation won't require them either.
//  *
//  * @param opts {Object}
//  *      - digest {String}
//  * @param cb {Function} `function (err, stream, ress)`
//  *      The `stream` is also an HTTP response object, i.e. headers are on
//  *      `stream.headers`. `ress` (plural of 'res') is an array of responses
//  *      after following redirects. The latest response is the same object
//  *      as `stream`. The full set of responses are returned mainly because
//  *      headers on both the first, e.g. 'Docker-Content-Digest', and last,
//  *      e.g. 'Content-Length', might be interesting.
//  */
// createBlobReadStream(opts, cb) {
//     this._headOrGetBlob({
//         method: 'get',
//         digest: opts.digest
//     }, function (err, ress) {
//         if (err) {
//             return cb(err, null, ress);
//         }

//         var stream = ress[ress.length - 1];
//         var numBytes = 0;

//         var dcdInfo;
//         var dcdHeader = ress[0].headers['docker-content-digest'];
//         if (dcdHeader) {
//             try {
//                 dcdInfo = _parseDockerContentDigest(dcdHeader);
//             } catch (parseErr) {
//                 return cb(new restifyErrors.BadDigestError(fmt(
//                     'could not parse Docker-Content-Digest header, "%s": %s',
//                     dcdHeader)));
//             }
//             if (dcdInfo.raw !== opts.digest) {
//                 return cb(new restifyErrors.BadDigestError(fmt(
//                     'Docker-Content-Digest header, %s, does not match ' +
//                     'given digest, %s', dcdInfo.raw, opts.digest)));
//             }
//         } else {
//             stream.log.debug({headers: ress[0].headers},
//                 'no Docker-Content-Digest header on GetBlob response');
//         }

//         stream.on('data', function (chunk) {
//             numBytes += chunk.length;
//             if (dcdInfo) {
//                 dcdInfo.hash.update(chunk);
//             }
//         });
//         stream.on('end', function () {
//             var cLen = Number(stream.headers['content-length']);
//             if (!isNaN(cLen) && numBytes !== cLen) {
//                 stream.emit('error', new errors.DownloadError(fmt(
//                     'unexpected downloaded size: expected %d bytes, ' +
//                     'downloaded %d bytes', cLen, numBytes)));
//             } else if (dcdInfo) {
//                 var digest = dcdInfo.hash.digest('hex');
//                 if (dcdInfo.expectedDigest !== digest) {
//                     stream.log.trace({expectedDigest: dcdInfo.expectedDigest,
//                         header: dcdInfo.raw, digest: digest},
//                         'Docker-Content-Digest failure');
//                     stream.emit('error', new restifyErrors.BadDigestError(
//                         'Docker-Content-Digest'));
//                 }
//             }
//         });

//         cb(null, stream, ress);
//     });
// };



// /*
//  * Upload an image manifest. `ref` is either a tag or a digest.
//  * <https://docs.docker.com/registry/spec/api/#pushing-an-image>
//  *
//  *   client.putManifest({manifest: <string>, ref: <tag or digest>},
//  *   function (err, res, digest, location) {
//  *      // Digest is `res.headers['docker-content-digest']`.
//  *   });
//  */
// putManifest(opts, cb) {
//     var this = this;
//     assert.object(opts, 'opts');
//     assert.optionalObject(opts.log, 'opts.log');
//     assert.string(opts.manifest, 'opts.manifest');
//     assert.string(opts.ref, 'opts.ref');
//     assert.func(cb, 'cb');

//     // Working variables.
//     var schemaVersion = 1;
//     // Result variables.
//     var digest;
//     var location;
//     var res;

//     var log = _createLogger(opts.log);
//     log.trace({
//         digest: opts.digest
//     }, 'putManifest');

//     vasync.pipeline({
//         arg: this,
//         funcs: [
//             function _getManifestVersion(_, next) {
//                 try {
//                     var manifest = JSON.parse(opts.manifest);
//                     if (manifest.hasOwnProperty('schemaVersion')) {
//                         schemaVersion = parseInt(manifest.schemaVersion, 10);
//                     }
//                 } catch (ex) {
//                     next(new errors.InvalidManifestError(
//                         'Unable to parse manifest string: ' + ex));
//                     return;
//                 }
//                 next();
//             },
//             function doLogin(_, next) {
//                 var resource = 'repository';
//                 var actions = ['pull', 'push'];
//                 var scope = _makeAuthScope(resource, this.repo.remoteName,
//                     actions);
//                 this.login({
//                     scope: scope
//                 }, next);
//             },
//             function _putManifest(_, next) {
//                 var headers = {
//                     'content-type': fmt(
//                         'application/vnd.docker.distribution.manifest.v%d+json',
//                         schemaVersion)
//                 };
//                 if (this._authInfo) {
//                     _setAuthHeaderFromAuthInfo(headers, this._authInfo);
//                 }
//                 this._httpapi.put({
//                     path: fmt('/v2/%s/manifests/%s',
//                         encodeURI(this.repo.remoteName),
//                         encodeURIComponent(opts.ref)),
//                     headers: headers
//                 }, function _afterCall(err, req) {
//                     if (err) {
//                         return next(err);
//                     }

//                     req.on('result', function onReqResult(reqErr, res_) {
//                         res = res_;
//                         if (reqErr) {
//                             registryError(reqErr, res, next);
//                             return;
//                         }

//                         var body = '';
//                         res.on('data', function onResChunk(chunk) {
//                             body += chunk;
//                         });

//                         res.on('end', function onResEnd() {
//                             var errMsg = _getRegistryErrMessage(body);
//                             if (errMsg) {
//                                 next(new errors.UploadError(errMsg));
//                                 return;
//                             }
//                             digest = res.headers['docker-content-digest'];
//                             location = res.headers.location;
//                             next();
//                         });
//                     });

//                     req.on('error', function onReqError(reqErr) {
//                         log.error({
//                             err: reqErr
//                         }, 'Error uploading manifest');
//                         return next(reqErr);
//                     });

//                     req.write(opts.manifest);
//                     req.end();
//                 });
//             }
//         ]
//     }, function _putManifestCb(err) {
//         cb(err, res, digest, location);
//     });
// };


// /*
//  * Upload a blob. The request stream will be used to
//  * complete the upload in a single request.
//  *
//  * <https://docs.docker.com/registry/spec/api/#starting-an-upload>
//  *
//  *   client.blobUpload({digest: <string>, stream: <object>,
//  *      contentLength: <number>},
//  *   function (err, res) { });
//  */
// blobUpload(opts, cb) {
//     var this = this;
//     assert.object(opts, 'opts');
//     assert.number(opts.contentLength, 'opts.contentLength');
//     assert.string(opts.digest, 'opts.digest');
//     assert.object(opts.stream, 'opts.stream');
//     assert.optionalString(opts.contentType, 'opts.contentType');
//     assert.optionalObject(opts.log, 'opts.log');
//     assert.func(cb, 'cb');

//     var log = _createLogger(opts.log);
//     log.trace({
//         contentLength: opts.contentLength,
//         digest: opts.digest
//     }, 'blobUpload');

//     // Working variables
//     var uploadUrl;
//     // Result variables.
//     var res;

//     vasync.pipeline({
//         arg: this,
//         funcs: [
//             function doLogin(_, next) {
//                 log.trace({digest: opts.digest}, 'blobUpload:: doLogin');
//                 var resource = 'repository';
//                 var actions = ['pull', 'push'];
//                 var scope = _makeAuthScope(resource, this.repo.remoteName,
//                     actions);
//                 this.login({
//                     scope: scope
//                 }, next);
//             },
//             function _getUploadUuid(_, next) {
//                 log.trace({digest: opts.digest}, 'blobUpload:: _getUploadUuid');
//                 var path = fmt('/v2/%s/blobs/uploads/',
//                     encodeURI(this.repo.remoteName));
//                 var headers = {};
//                 if (this._authInfo) {
//                     _setAuthHeaderFromAuthInfo(headers, this._authInfo);
//                 }
//                 this._api.post({
//                     path: path,
//                     headers: headers
//                 }, function _afterCall(err, req, res_) {
//                     if (err) {
//                         next(err);
//                         return;
//                     }
//                     uploadUrl = res_.headers.location;
//                     if (!uploadUrl) {
//                         next(new errors.UploadError(
//                             'No registry upload location header returned'));
//                         return;
//                     }
//                     next();
//                 });
//             },
//             function _putBlob(_, next) {
//                 assert.string(uploadUrl, 'uploadUrl');
//                 log.trace({digest: opts.digest}, 'blobUpload:: _putBlob');
//                 var urlSep = '?';
//                 if (uploadUrl.indexOf('?') > 0) {
//                     urlSep = '&';
//                 }
//                 var path = fmt('%s%sdigest=%s', uploadUrl, urlSep,
//                     encodeURIComponent(opts.digest));
//                 var headers = {
//                     'content-length': opts.contentLength,
//                     'content-type': (opts.contentType ||
//                         'application/octet-stream')
//                 };
//                 _setAuthHeaderFromAuthInfo(headers, this._authInfo);
//                 this._httpapi.put({
//                     path: path,
//                     headers: headers
//                 }, function _afterCall(err, req) {
//                     log.trace({digest: opts.digest, err: err},
//                         'blobUpload:: put connected');
//                     if (err) {
//                         next(err);
//                         return;
//                     }
//                     // Pipe through the stream data.
//                     var stream = opts.stream;

//                     function removeListeners() {
//                         stream.removeListener('error', onStreamPipeError);
//                         req.removeListener('result', onReqResult);
//                         req.removeListener('error', onReqError);
//                     }

//                     req.on('result', onReqResult);
//                     function onReqResult(reqErr, res_) {
//                         log.trace({digest: opts.digest},
//                             'blobUpload:: onResult');
//                         res = res_;
//                         if (reqErr) {
//                             removeListeners();
//                             registryError(reqErr, res, next);
//                             return;
//                         }

//                         var body = '';
//                         res.on('data', function onResChunk(chunk) {
//                             body += chunk;
//                         });

//                         res.on('end', function onResEnd() {
//                             removeListeners();
//                             var errMsg = _getRegistryErrMessage(body);
//                             if (errMsg) {
//                                 next(new errors.UploadError(errMsg));
//                                 return;
//                             }
//                             next();
//                         });
//                     }

//                     req.on('error', onReqError);
//                     function onReqError(reqErr) {
//                         log.error({
//                             digest: opts.digest,
//                             err: reqErr
//                         }, 'Error sending blob');
//                         removeListeners();
//                         return next(reqErr);
//                     }

//                     stream.on('error', onStreamPipeError);
//                     function onStreamPipeError(streamErr) {
//                         log.error({
//                             digest: opts.digest,
//                             err: streamErr
//                         }, 'Error piping blob');
//                         removeListeners();
//                         req.end();
//                         return next(streamErr);
//                     }

//                     log.trace({digest: opts.digest},
//                         'blobUpload:: piping stream to req');
//                     stream.pipe(req);
//                 });
//             }
//         ]
//     }, function _blobUploadCb(err) {
//         cb(err, res);
//     });
// };

}

export function createClient(opts: RegistryClientV2Opts) {
    return new RegistryClientV2(opts);
}
