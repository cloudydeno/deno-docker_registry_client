#!/usr/bin/env -S deno run --allow-net

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

import { mainline } from "../mainline.ts";
import { parseRepoAndRef } from "../../lib/common.ts";
import { createClient } from "../../lib/registry-client-v2.ts";

// Shared mainline with examples/foo.js to get CLI opts.
const {opts, args} = mainline({
    cmd: 'getManifest',
    options: [{
        names: ['accept-list'],
        type: 'bool',
        help: 'Accept manifest lists (multiarch support) from the registry',
    }],
});
var name = args[0];
if (!name) {
    console.error('usage: node examples/v2/%s.js REPO[:TAG|@DIGEST]\n');
    Deno.exit(2);
}


// The interesting stuff starts here.
var rar = parseRepoAndRef(name);
var client = createClient({
    repo: rar,
    // log: log,
    insecure: opts.insecure,
    username: opts.username,
    password: opts.password,
    maxSchemaVersion: (opts.schema || 2)
});
var tagOrDigest = rar.tag || rar.digest || '';
const {resp, manifest} = await client.getManifest({
    ref: tagOrDigest,
    acceptManifestLists: opts['accept-list'],
});

console.error('# response headers');
console.table(Array.from(resp.headers));
console.error('# manifest');
console.log(manifest);