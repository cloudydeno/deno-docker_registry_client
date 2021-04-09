#!/usr/bin/env -S deno run

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { parseRepo } from "../lib/common.ts";

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * An example showing how a repo string is parsed.
 */

if (Deno.args.length !== 1) {
    console.error(
        'usage:\n' +
        '    node examples/parseRepo.ts [INDEX/]REPO\n');
    Deno.exit(2);

}

var repo = parseRepo(Deno.args[0]);
console.log(JSON.stringify(repo, null, 4));
