// IFSC (Indian Financial System Code): the 11-character code of a bank
// branch, needed for NEFT, RTGS and IMPS transfers (ADR-025). Four letters
// for the bank, a zero, six letters or digits for the branch: the shape
// SBIN0 + six more.
//
// - VALIDATED: the bank code is on the list below. The shape, the fixed
//   zero and a real bank's code are the evidence, so it is redacted
//   whatever the text around it says (ADR-010).
// - UNVALIDATED: any other four letters. Accepted only with a keyword
//   nearby ("IFSC", "NEFT", "RTGS", "IMPS", "branch", context.ts): a
//   product code can have the same shape.
//
// Matched in any case, like PAN: people type "sbin0001234", and it is the
// same code (the bank code is looked up in capitals). No check digit exists.
//
// The zero must be a zero. A letter O in its place, a common typing slip,
// is not matched; nor is a code written with a space or hyphen after the
// bank code. Both are known limits (ADR-025).
//
// Not glued to a letter, digit, mark or underscore: an IFSC-shaped stretch
// inside a longer token is not an IFSC. Nor to "@": there it is part of an
// email address or a UPI ID (bug-log 27).
//
// This runs on normalised text: a full-width IFSC arrives here as ASCII.

import type { Candidate } from './types.js';

// The bank codes of every bank with branches in RBI's list of NEFT-enabled
// branches ("Bank-wise IFSC", updated 2026-09-15), 260 codes. RBI's page
// could be read on 2026-10-01, but its per-bank Excel files are behind a
// script challenge and could not be downloaded, so the codes were taken
// from Razorpay's open-source copy of those files (github.com/razorpay/ifsc,
// MIT licence, src/IFSC.json, last changed 2026-09-01): the four-letter keys
// that have branches. Of the 234 bank names on RBI's page, 179 match a name
// in that dataset exactly; the ones checked by hand among the rest differ
// only in spelling (IDBI is IBKL, DBS is DBSS). Merged banks that still
// have a branch in the list (Andhra Bank, Corporation Bank, Vijaya Bank…)
// are kept: their old codes are still written in old records. The
// generator keeps its own, shorter list (ADR-008).
export const IFSC_BANK_CODES: ReadonlySet<string> = new Set(
  `
  AANB ABHY ABNA ADBK ADCC AHDC AIRP AJAR AJHC AKJB ALLA AMCB AMDN
  ANDB ANZB APBL APGB APGV APMC ARBL ASBL AUBL AUCB BACB BARA BARB
  BARC BBKM BCBM BCEY BCHN BDBL BKDN BKID BMCB BNPA BNSB BOFA BOTM
  BUCB CBIN CCBL CCIL CHAS CITI CIUB CLBL CNRB COAS CORP COSB CRES
  CRGB CRLY CRUB CSBK CSBX CTCB DBSS DCBL DCUB DEOB DEUT DICG DLSC
  DLXB DMKJ DNSB DOHB DURG EBIL EIBI ESFB ESMF FDRL FINO FIRN FSFB
  GABK GBCB GDCB GSCB GSSB HARC HCBL HDFC HITP HPSC HSBC HUSB HVBK
  IBBK IBKL IBKO ICBK ICIC ICLL IDFB IDIB INDB INPA IOBA IPOS JAKA
  JANA JASB JIOP JJSB JPCB JSBL JSBP JSFB JTSC KACE KAIJ KANG KARB
  KBKB KCCB KJSB KKBK KLGB KNBL KNSB KOEX KOLH KSBK KSCB KUCB KVBL
  KVGB LAVB LUCB MAHB MAHG MCAB MCBL MDBK MDCB MHCB MSBL MSCI MSHQ
  MSLM MSNU MUBL MVCB NBAD NBRD NCUB NDVS NESF NGSB NHBA NICB NJBK
  NKGS NMCB NNSB NOSC NSPB NTBL NVNM ORBC ORCB PHNP PJSB PKGB PMEC
  PPNT PSBL PSIB PUCB PUNB PYTM QNBA RABO RATN RBIN RBIP RBIS RDCB
  RMGB RNSB RRBP RSBL RSCB RSSB SABR SAHE SANT SBIN SCBL SDCB SDCE
  SECB SHBK SIBL SIDC SJSB SKNB SKSB SMBC SMCB SMNB SNBK SOGE SPCB
  SRCB STCB SUNB SURY SUSB SUTB SVCB SVSH SYNB TAUB TBMC TBSB TCBR
  TDCB TGMB TGRB TJSB TMBL TMSB TNCB TNGB TNSC TPSC TSAB TSSB TTCB
  UBIN UCBA UCLB UJVN UNBA UOVB UPCB URBN USCB UTBI UTIB UTKS UUCB
  VARA VASJ VCOB VIJB VSBA VSBL VTBJ VVSB WBSC XNSE YESB ZCBL ZSBL
  `
    .trim()
    .split(/\s+/),
);

const IFSC_PATTERN = /(?<![\p{L}\p{N}\p{M}_@])[A-Za-z]{4}0[A-Za-z0-9]{6}(?![\p{L}\p{N}\p{M}_@])/gu;

export function* ifscCandidates(text: string): Generator<Candidate> {
  for (const m of text.matchAll(IFSC_PATTERN)) {
    yield {
      type: 'IFSC',
      start: m.index,
      end: m.index + 11,
      validated: IFSC_BANK_CODES.has(m[0].slice(0, 4).toUpperCase()),
    };
  }
}
