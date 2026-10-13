# Person names: install, licence and CPUs

The detail behind the README's [Person names](../README.md#person-names)
section, moved here from the README on 2026-10-14 so that the README stays
short. The text is the README's as it stood then; only its links were
changed to work from this folder, and the figures table it introduced
stays in the README. How names are found, what they cost and how the
feature fails closed are in the README; every setting is in the
[user manual](user-manual.md).

## Install

- **Install:** the runtime (`onnxruntime-node` 1.30.0,
  `@huggingface/tokenizers` 0.2.0) is an exact optional dependency, about
  302 MB on Windows and 301 MB of it on Linux (measured 2026-10-07), never loaded with names off
  (on Linux x64 set `ONNXRUNTIME_NODE_INSTALL=skip` when installing, or its
  install script also downloads 273 MB of GPU libraries that names never
  load: measured, ADR-036);
  the model comes from `npm run fetch:model` (178.5 MB), kept only if its
  SHA-256 matches, and checked again at start-up: with names on, the
  gateway refuses to start if the list, a file or the runtime is wrong or
  missing ([ADR-036](decisions.md#adr-036)).

## Licence

- **Licence** (not legal advice;
  [ADR-036](decisions.md#adr-036), licence amendment of 2026-10-11):
  - **The files state no licence.** Xenova's repository, which the files
    are downloaded from, gives none. They are used on the strength of its
    card's statement that they are
    [Davlan's model](https://huggingface.co/Davlan/bert-base-multilingual-cased-ner-hrl)
    (AFL-3.0) converted to ONNX; Davlan's model is a fine-tune of Google's
    multilingual BERT (Apache-2.0). If that statement were wrong, there
    would be no stated licence for these files. The files are never in
    this repository or the Docker image: `npm run fetch:model` downloads
    them and prints the licence and its link.
  - **The training data's terms were not checked.** Davlan's card lists
    CoNLL 2002 and 2003, ANERcorp, Europeana Newspapers, I-CAB, Latvian
    NER, Paramopama + Second HAREM and MSRA. Whether a dataset's terms
    reach a model trained on it is legally unsettled. Names are off by
    default; an operator who switches them on should assess those terms
    for their own use.

## Which CPUs the figures hold on

- **Which CPUs the figures hold on.** They were measured on an Intel Core
  i5-12450H. Under a rule written and committed before any Linux run
  ([ADR-036](decisions.md#adr-036), Phase 6c), the same comparison,
  every span by SHA-256:
  - **Two answers, split by instruction set, not by CPU model.** Every
    machine so far gave one of exactly two sets of spans, byte for byte.
    Which one followed whether the machine has AVX-512:
    - **without AVX-512, the published figures reproduce exactly:** the
      i5-12450H under Linux (Debian 12 in a container), GitHub runners'
      **AMD EPYC 7763** (six runs), and a runner reporting **AMD EPYC
      9V74** whose virtual machine hid AVX-512;
    - **with AVX-512, one extra name is found:** runners' **Intel Xeon
      Platinum 8573C** and **Intel Xeon 6973P-C**, and a runner reporting
      the **same AMD EPYC 9V74** model name whose virtual machine showed
      AVX-512.

    So one CPU model name sits on both sides. The two Xeons' runs, and an
    earlier EPYC 9V74 run, did not log what their virtual machine showed.
    Their chips have AVX-512, so they are consistent with the split, but not
    observations of it. The operating system is ruled out (the same Linux
    on both sides). Their figures (runs of 2026-10-07 to 2026-10-10),
    beside the published ones, never in their place, are the table in the
    README's [Person names](../README.md#person-names) section.

  - **What the difference is.** From the counts, it is one extra correct
    name: a three-part English name in a sentence, the rest unchanged. Counts
    cannot rule out changes that cancel each other out.
  - **Why: a hypothesis, not a finding.** The likely reason is that the
    runtime picks its compute kernels by instruction set. It predicted
    four later runs' results before they were looked at: three of those
    predictions were committed in advance, including the two for the runs
    that share the EPYC 9V74 name. It is still
    **not shown**: no run has looked at which kernels were chosen. The
    held-out figure stays the i5-12450H's. **Not adopted: names checks on every push.** A rule set
    in advance decided it, closed out early on 2026-10-10 at 10 counted
    runs. One CPU model name turned out to cover two instruction sets on
    GitHub's runners, so two runs from before the CPU flags were logged can
    never be matched to a baseline, and the rule's condition can never be
    met. On the one CPU key with a baseline, the names reproduced exactly
    in six runs of six ([ADR-036](decisions.md#adr-036), close-out).
    The Names workflow still runs by hand (its temporary daily run was
    removed on 2026-10-10), comparing each run with its own CPU model's
    baseline (a CPU with none passes with a warning).
