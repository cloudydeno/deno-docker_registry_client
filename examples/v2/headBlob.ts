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
import { RegistryClientV2 } from "../../lib/registry-client-v2.ts";

// Shared mainline with examples/foo.js to get CLI opts.
const {opts, args} = mainline({cmd: 'headBlob'});
const name = args[0];
if (!name) {
    console.error('usage: node examples/v2/%s.js REPO@DIGEST');
    Deno.exit(2);
}


// The interesting stuff starts here.
const rat = parseRepoAndRef(name);
if (!rat.digest) throw new Error('must specify a @DIGEST');
const client = new RegistryClientV2({
    repo: rat,
    insecure: opts.insecure,
    username: opts.username,
    password: opts.password
});
const ress = await client.headBlob({digest: rat.digest});
for (let i = 0; i < ress.length; i++) {
    console.log('# response %d headers', i+1);
    console.table(Array.from(ress[i].headers));
}
