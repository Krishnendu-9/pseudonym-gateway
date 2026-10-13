# Threat model: detail

The detail behind the README's
[Threat model (summary)](../README.md#threat-model-summary), moved here
from the README on 2026-10-14 so that the README stays short. What
Pseudonym protects against, what it does not, Google's free tier and what
the logs contain stay in the README; the entries below are the README's
text as it stood then, with only their links changed to work from this
folder. The decision behind each part, and what was measured for it, is
in the [decision record](decisions.md).

## Inside Pseudonym

**Inside Pseudonym:** the mapping from placeholders back to real values
exists only in memory for one request, and is never logged, stored or put in
an error. It is not encrypted (the key would sit in the same process), and
JavaScript strings cannot be reliably wiped, so someone who can read the
process's memory can read values ([ADR-012](decisions.md#adr-012)).
On every start, Pseudonym refuses to start if the debugger, heap snapshots
or diagnostic reports could be switched on, or, on Linux, if core dumps are
enabled or `--disable-sigusr1` is missing. Only
`PSEUDONYM_DISABLE_HARDENING=true` turns that check off, and Pseudonym then
says so on every start. `NODE_ENV` does not affect it: a development
`.env`, which says `NODE_ENV=development`, used to switch it off silently
([ADR-047](decisions.md#adr-047)). It cannot stop a host that pipes
core dumps to a handler (the kernel then ignores the limit; Pseudonym
warns), and it can verify none of this on Windows or macOS. Production
means Linux ([ADR-016](decisions.md#adr-016)).

## In a container

**In a container,** the loopback default does not protect anything. The
image listens on `0.0.0.0`, because inside a container `127.0.0.1` cannot
be reached from outside it. Who can reach the gateway is then decided by
the network in front of it: the Docker networks the container is on, and
which ports are published on which host interface. The compose file
publishes on the host's loopback only
([ADR-046](decisions.md#adr-046)).

## A dependency's telemetry

**Disclosed: a dependency's telemetry (found 2026-10-10).** ONNX Runtime
1.30.0, the library that runs the person-name model, sends usage telemetry
to Microsoft by default. Pseudonym loads it only with names on; with names
off it is never loaded.

**What ships does not send it.** The shipped artifact is the Linux
container. There, telemetry is forced off in code and proven off by a
negative control. The exposure is the development environment on Windows,
not the product.

- **What it sends:** the CPU model, a device ID, and for each model it
  loads the model's file name, hashes and metadata. It does not send
  request text.
- **How it was found:** while testing the Docker image, by a line in the
  container's log, then confirmed in ONNX Runtime's source.

**Linux: a bug, fixed.** Out of the box, the runtime's own client queues
the events on disk and sends them to `mobile.events.data.microsoft.com`.
Since 2026-10-10 Pseudonym forces it off in code before the model loads,
whatever the environment says.

- **Shown by a negative control, not asserted:** in the shipped image,
  with the switch set back to "on" from outside, the runtime wrote nothing.
  The shipped image built before the fix wrote a device ID and a queue of
  unsent events.
- **The shipped image could not have uploaded, even with telemetry on.** It
  is built on `node:22.23.3-bookworm-slim`, which has no `ca-certificates`.
  None of the six certificate files the runtime looks for is present, and
  `SSL_CERT_FILE` is unset. The queued events were observed; an upload was
  not, and could not have happened. (Checked 2026-10-10 on the built
  image.)
- **What was probably sent and cannot be undone: the Phase 6c run, not the
  shipped image.** That run (2026-10-07) used a different image, the full
  `node:22.23.3-bookworm` at the digest recorded in ADR-036. That image
  carries `ca-certificates` (version 20250419~deb12u1, checked 2026-10-10
  on that same digest), and the run set no CI variable. It ran names, and
  so **probably uploaded one session's events**. That cannot be verified or
  taken back.
- **GitHub's runners had telemetry off:** the runtime turns it off itself
  when it sees a CI variable.

**Windows: a platform limitation, not fixable from Pseudonym.** At ONNX
Runtime 1.30.0, the Windows build ignores the off switch. The only other
off switch is a C API call that the Node binding does not expose.

- **Where the events go:** the runtime hands them to Windows' own
  diagnostic pipeline, which uploads according to the machine's
  diagnostic-data setting.
- **Shown at start-up:** with names on, Pseudonym prints one line on
  Windows saying this cannot be turned off, and pointing here.
- **An operator's options:** keep names off (the runtime is then never
  loaded); run the Linux container; or set Windows' own diagnostic-data
  setting as low as the edition allows. Whether Windows' lowest available
  setting (Required, on Home) leaves these events out is not established.
- **Unobserved, and resting on inference.** The DLL registers Microsoft's
  telemetry provider, and the source says it is on by default, but no
  telemetry event has been observed firing on Windows. Watching for them
  needs an elevated trace (the testing guide has the `logman` commands).
  That check is the maintainer's to run, and this entry stays marked
  unobserved until it is.

([ADR-046](decisions.md#adr-046), item 8 and amendments A and D.)

(The start-up line points to the README's threat model, entry
"Disclosed: a dependency's telemetry", which summarises this and links
here.)
