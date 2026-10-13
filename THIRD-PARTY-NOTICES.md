# Third-party notices

Pseudonym's own code is under the MIT licence in [LICENSE](LICENSE). This
file holds the notices for material by others that is copied into this
repository.

Not covered here, because none of it is in this repository: the npm
packages, which `npm install` fetches with their own licence files; and
the person-name model, which `npm run fetch:model` downloads and whose
licence it prints ([ADR-036](docs/decisions.md#adr-036)).

## Razorpay IFSC dataset

**What is used:** the 260 four-letter bank codes in
[`src/detection/ifsc.ts`](src/detection/ifsc.ts) (`IFSC_BANK_CODES`): the
keys of `src/IFSC.json` that have at least one branch, as that file stood
when last changed on 2026-09-01.

**Source:** [github.com/razorpay/ifsc](https://github.com/razorpay/ifsc)
([ADR-025](docs/decisions.md#adr-025)).

**Licence:** MIT. Its notice, as MIT asks that it be included
([ADR-036](docs/decisions.md#adr-036), licence amendment of 2026-10-11):

```text
The MIT License (MIT)

Copyright (c) 2020 Razorpay

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
