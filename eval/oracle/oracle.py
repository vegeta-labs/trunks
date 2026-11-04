#!/usr/bin/env python3
"""Independent Python oracle for the Deal Ops Inbox E1, E3, E4 and E6 rules.

Written only from docs/01_PRD.md, docs/04_TEST_PLAN.md, eval/SCHEMA.md and
eval/oracle/BRIEF.md. Python 3.11 standard library only.

CLI: reads JSON Lines on stdin, each {"fn": <name>, "input": {...}}, and
writes one JSON line per input: {"ok": true, "output": ...} or
{"ok": false, "error": "..."}.

Every interpretation of ambiguous PRD text is marked with a comment that
starts "# READING:" and is listed in eval/oracle/READINGS.md.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import unicodedata
from email.utils import parseaddr
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------------------
# I-04 text normalisation
# ---------------------------------------------------------------------------


# PRD v0.7.3 I-04: every Default_Ignorable_Code_Point is deleted as well.
# READING: the standard library has no DICP property, so the ranges are
# written out from DerivedCoreProperties.txt (Unicode 15). Check against the
# Unicode version the product uses.
_DICP_RANGES = (
    (0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160),
    (0x17B4, 0x17B5), (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E),
    (0x2060, 0x206F), (0x3164, 0x3164), (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
)


def _is_dicp(c: str) -> bool:
    o = ord(c)
    return any(a <= o <= b for a, b in _DICP_RANGES)


def normalize_text(text: str) -> str:
    """I-04: Unicode NFKC, then delete every Cf and Default_Ignorable_Code_Point character."""
    # READING: NFKC and the deletion are repeated until the text is stable, so
    # that a deleted character separating two characters that NFKC would
    # combine does not leave a non-normalised result.
    prev = None
    while prev != text:
        prev = text
        text = unicodedata.normalize("NFKC", text)
        text = "".join(c for c in text if unicodedata.category(c) != "Cf" and not _is_dicp(c))
    return text


def normalize(inp):
    return {"text": normalize_text(inp["text"])}


# ---------------------------------------------------------------------------
# I-05 whole-word list matching
# ---------------------------------------------------------------------------


def _is_word_char(c: str) -> bool:
    # READING: "letter or digit" (I-05 «词的前后不是字母或数字») = Unicode
    # general category L* or N*. Only these can start a word.
    cat = unicodedata.category(c)
    return cat[0] in ("L", "N")


def _is_mark(c: str) -> bool:
    return unicodedata.category(c)[0] == "M"


def _word_key(w: str) -> str:
    # PRD v0.7.17: «比较两个词时先去掉附加符». READING: marks are removed both
    # before and after Unicode casefold (casefold can itself produce a mark,
    # e.g. U+0130 -> "i" + U+0307), so the comparison form has no M* at all.
    # A mark that NFKC composed into its base letter (e + U+0301 -> é) is no
    # longer a mark and is kept: "passporté" is not "passport".
    w = "".join(c for c in w if not _is_mark(c)).casefold()
    return "".join(c for c in w if not _is_mark(c))


def _tokens(text: str):
    """Words of the text: (start, end, comparison key) over the given text.

    A word is a letter/digit followed by any run of letters, digits and
    combining marks; text[start:end] is the word as written (marks included).
    """
    # READING (PRD I-05 v0.7.17): a combining mark (M*) belongs to the letter
    # before it and does not split the word (Devanagari vowel signs, Arabic
    # harakat, a U+0301 that NFKC leaves standing after "t"). "The letter
    # before it" is read as "the word character before it": a mark directly
    # after a digit, or after another mark of the same word, also stays in
    # the word. A mark with no letter/digit before it (start of text, or
    # after a space or punctuation) belongs to no word and is a separator, so
    # a lone mark never forms a word.
    out = []
    i, n = 0, len(text)
    while i < n:
        if _is_word_char(text[i]):
            j = i + 1
            while j < n and (_is_word_char(text[j]) or _is_mark(text[j])):
                j += 1
            out.append((i, j, _word_key(text[i:j])))
            i = j
        else:
            i += 1
    return out


def _phrase_words(phrase: str):
    return [w for _, _, w in _tokens(normalize_text(phrase))]


def _phrase_spans(tokens, phrase: str):
    """All (start, end) spans in the tokenised text where the phrase occurs as a whole-word sequence."""
    # READING: any run of non-letter/non-digit characters (whitespace or
    # punctuation, any length, including line breaks) separates the words of
    # a multi-word phrase (I-05 "中间的空白和标点视为分隔"). So "a/c" is the word
    # sequence [a, c], and "don't tell" is [don, t, tell].
    words = _phrase_words(phrase)
    if not words:
        return []
    k = len(words)
    spans = []
    for i in range(len(tokens) - k + 1):
        if all(tokens[i + j][2] == words[j] for j in range(k)):
            spans.append((tokens[i][0], tokens[i + k - 1][1]))
    return spans


def wordlist_match(inp):
    text = normalize_text(inp["text"])
    toks = _tokens(text)
    matched = [p for p in inp["phrases"] if _phrase_spans(toks, p)]
    return {"matched": matched}


# ---------------------------------------------------------------------------
# I-01 amount numbers
# ---------------------------------------------------------------------------

SUPPORTED_CURRENCIES = ("GBP", "EUR", "USD")  # PRD I-01 default configuration

I01_MAX_MINOR = 1_000_000_000_00  # PRD v0.7.1 I-01 upper bound, in minor units

_I01_RE = re.compile(r"(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]{1,2}))?")


def parse_amount_number_str(s):
    if s is None:
        return None
    # READING: the number must match exactly; no surrounding whitespace, sign,
    # leading "." (".5") or trailing "." ("5.") is accepted. Thousands groups
    # must be exactly three digits after the first group of 1-3 digits.
    m = _I01_RE.fullmatch(s)
    if not m:
        return None
    if "." in s:
        int_part, dec = s.split(".")
    else:
        int_part, dec = s, ""
    int_part = int_part.replace(",", "")
    dec = (dec + "00")[:2]
    minor = int(int_part) * 100 + int(dec)
    # PRD v0.7.1 I-01: amounts above 1,000,000,000.00 are unparseable
    # (1,000,000,000.00 itself is accepted).
    return minor if minor <= I01_MAX_MINOR else None


def parse_amount_number(inp):
    return {"minor": parse_amount_number_str(inp["s"])}


# ---------------------------------------------------------------------------
# C-EXT-3 amounts in free text
# ---------------------------------------------------------------------------

# READING: "US$" is recognised only in upper case; the three-letter codes are
# case-insensitive (PRD says so only for the codes).
_MARKER_RE = re.compile(r"US\$|£|€|\$|[Gg][Bb][Pp]|[Ee][Uu][Rr]|[Uu][Ss][Dd]")
_RUN_RE = re.compile(r"[0-9](?:[0-9.,]*[0-9])?")
_MINUS = ("-", "−")


def _marker_currency(m: str) -> str:
    if m == "£":
        return "GBP"
    if m == "€":
        return "EUR"
    if m in ("$", "US$"):
        return "USD"
    return m.upper()


def _amount_before_ok(text: str, i: int) -> bool:
    """Character immediately before the token (index i-1) is an allowed boundary."""
    if i == 0:
        return True
    c = text[i - 1]
    # A comma before the token would be followed by the token, not by
    # whitespace, so it is never an allowed boundary (",(逗号后须有空白)").
    return c.isspace() or c in "();:"


def _amount_after_ok(text: str, j: int) -> bool:
    if j >= len(text):
        return True
    c = text[j]
    if c.isspace() or c in "();:":
        return True
    if c in ",.":
        # READING: "句末 ." = a full stop followed by whitespace or end of text;
        # a comma must likewise be followed by whitespace or end of text.
        return j + 1 >= len(text) or text[j + 1].isspace()
    return False


def _amount_tokens(text: str):
    """Valid amount tokens as dicts with start, end, minor, currency (C-EXT-3, v0.7.1)."""
    cands = []  # (start, end, glued, number_str, currency)
    for mm in _MARKER_RE.finditer(text):
        ms, me = mm.start(), mm.end()
        cur = _marker_currency(mm.group(0))
        # Prefix form: marker [one space] number
        p, glued = me, True
        if p < len(text) and text[p] == " " and p + 1 < len(text) and text[p + 1].isdigit():
            p += 1
            glued = False
        if p < len(text) and "0" <= text[p] <= "9":
            rm = _RUN_RE.match(text, p)
            if rm:
                cands.append((ms, rm.end(), glued, rm.group(0), cur))
        # Suffix form: number [one space] marker
        q, glued = ms, True
        if q > 0 and text[q - 1] == " " and q - 1 > 0 and "0" <= text[q - 2] <= "9":
            q -= 1
            glued = False
        if q > 0 and "0" <= text[q - 1] <= "9":
            k = q
            while k > 0 and (text[k - 1] in "0123456789.,"):
                k -= 1
            while k < q and text[k] in ".,":
                k += 1
            cands.append((k, me, glued, text[k:q], cur))
    # PRD v0.7.1: a candidate with bad boundaries or that is void (minus sign
    # before it, number part not I-01) does not occupy its marker or number.
    valid = []
    for start, end, glued, num, cur in cands:
        if start > 0 and text[start - 1] in _MINUS:
            continue
        if not (_amount_before_ok(text, start) and _amount_after_ok(text, end)):
            continue
        minor = parse_amount_number_str(num)
        if minor is None:
            continue
        valid.append({"start": start, "end": end, "glued": glued, "minor": minor, "currency": cur})
    # PRD v0.7.1: each marker (and, READING, each number) belongs to one
    # token. Candidates whose marker touches the number win; otherwise the
    # leftmost wins. Two candidates conflict when their spans share a
    # character (they share the marker or the number).
    valid.sort(key=lambda t: (not t["glued"], t["start"]))
    taken = []
    for t in valid:
        if all(t["end"] <= o["start"] or o["end"] <= t["start"] for o in taken):
            taken.append(t)
    taken.sort(key=lambda t: t["start"])
    return taken


def amounts(inp):
    text = normalize_text(inp["text"])
    res = []
    for t in _amount_tokens(text):
        # READING: only configured currencies (default GBP, EUR, USD); all
        # markers map to these three, so no filtering is needed here.
        res.append({"minor": t["minor"], "currency": t["currency"], "start": t["start"], "end": t["end"]})
    return {"amounts": res}


# ---------------------------------------------------------------------------
# MT103 :32A:
# ---------------------------------------------------------------------------

# READING: ":32A:" must not be preceded by a letter/digit; the value follows
# immediately with no whitespace: YYMMDD, 3 upper-case letters, digits, a
# mandatory decimal comma (SWIFT format) and 0-2 decimals; no thousands
# separators. A field with an invalid calendar date, more than 2 decimals or
# an unsupported currency yields no item.
_MT103_RE = re.compile(r"(?<![0-9A-Za-z]):32A:([0-9]{2})([0-9]{2})([0-9]{2})([A-Z]{3})([0-9]+),([0-9]{0,2})(?![0-9,])")


def _valid_date(y: int, m: int, d: int) -> bool:
    import datetime
    try:
        datetime.date(y, m, d)
        return True
    except ValueError:
        return False


def mt103(inp):
    text = normalize_text(inp["text"])
    items = []
    for m in _MT103_RE.finditer(text):
        yy, mo, dd, cur, ip, dp = m.groups()
        y, mo_i, d_i = 2000 + int(yy), int(mo), int(dd)
        if not _valid_date(y, mo_i, d_i):
            continue
        if cur not in SUPPORTED_CURRENCIES:
            continue
        minor = int(ip) * 100 + int((dp + "00")[:2])
        # READING: the I-01 upper bound (v0.7.1) also applies to :32A:; only
        # the number format differs there ("MT103 :32A: 另按 C-EXT-3").
        if minor > I01_MAX_MINOR:
            continue
        items.append({"value_date": "%04d-%02d-%02d" % (y, mo_i, d_i), "minor": minor, "currency": cur})
    return {"items": items}


# ---------------------------------------------------------------------------
# pacs.008 XML
# ---------------------------------------------------------------------------

PACS008_NS_PREFIX = "urn:iso:std:iso:20022:tech:xsd:pacs.008."
XML_MAX_BYTES = 1024 * 1024  # READING: "1 MB" = 1,048,576 bytes of the UTF-8 encoding


def _split_tag(tag: str):
    if tag.startswith("{"):
        ns, local = tag[1:].split("}", 1)
        return ns, local
    return "", tag


def _is_pacs_document(el) -> bool:
    ns, local = _split_tag(el.tag)
    return local == "Document" and ns.startswith(PACS008_NS_PREFIX) and len(ns) > len(PACS008_NS_PREFIX)


def _child(el, local):
    for c in el:
        if _split_tag(c.tag)[1] == local:
            return c
    return None


def _children(el, local):
    return [c for c in el if _split_tag(c.tag)[1] == local]


def _iso_date_or_none(s):
    if s is None:
        return None
    s = normalize_text(s).strip()
    m = re.fullmatch(r"([0-9]{4})-([0-9]{2})-([0-9]{2})", s)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return s if _valid_date(y, mo, d) else None


def pacs008(inp):
    xml = inp["xml"]
    if len(xml.encode("utf-8")) > XML_MAX_BYTES:
        return {"parsed": False, "reason": "too_large"}
    # READING: any "<!DOCTYPE" or "<!ENTITY" anywhere (case-insensitive) means
    # the XML contains a DTD / entity declaration and is not parsed, even if
    # it sits inside a comment or CDATA section (conservative).
    if re.search(r"<!\s*(DOCTYPE|ENTITY)", xml, re.IGNORECASE):
        return {"parsed": False, "reason": "dtd_or_entity"}
    # READING: XML is parsed from the original text (I-04 would change markup
    # such as full-width "<"); I-04 is applied to the extracted element values.
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return {"parsed": False, "reason": "malformed"}
    except ValueError:
        return {"parsed": False, "reason": "malformed"}
    doc = None
    if _is_pacs_document(root):
        doc = root
    else:
        # READING: the Business Application Header envelope is any root element
        # whose direct children include an element named AppHdr (any
        # namespace) and a pacs.008 Document.
        if _child(root, "AppHdr") is not None:
            for c in root:
                if _is_pacs_document(c):
                    doc = c
                    break
    if doc is None:
        return {"parsed": False, "reason": "not_pacs008"}
    items = []
    # READING: CdtTrfTxInf and GrpHdr are direct children of the message
    # element(s) directly under Document (normally FIToFICstmrCdtTrf); child
    # names are matched by local name.
    for msg in doc:
        grp = _child(msg, "GrpHdr")
        grp_date = _iso_date_or_none(_child(grp, "IntrBkSttlmDt").text) if grp is not None and _child(grp, "IntrBkSttlmDt") is not None else None
        for tx in _children(msg, "CdtTrfTxInf"):
            # PRD v0.7.1 C-EXT-3: amount, value date and UETR of each
            # CdtTrfTxInf are judged independently; an invalid one voids only
            # itself, and the transaction still yields an item.
            # READING: "the amount" is minor + currency together: a missing
            # element, an amount failing I-01 or an unsupported Ccy (upper-cased)
            # makes both null.
            minor, ccy = None, None
            amt_el = _child(tx, "IntrBkSttlmAmt")
            if amt_el is not None:
                c = normalize_text(amt_el.get("Ccy") or "").strip().upper()
                m = parse_amount_number_str(normalize_text(amt_el.text or "").strip())
                if m is not None and c in SUPPORTED_CURRENCIES:
                    minor, ccy = m, c
            dt_el = _child(tx, "IntrBkSttlmDt")
            vd = _iso_date_or_none(dt_el.text) if dt_el is not None else None
            if dt_el is None:
                vd = grp_date
            # READING: if CdtTrfTxInf/IntrBkSttlmDt exists but is invalid, the
            # value date is null (no fallback to GrpHdr: "没有则" = absent).
            uetr, uetr_invalid = None, None
            pmt = _child(tx, "PmtId")
            if pmt is not None and _child(pmt, "UETR") is not None:
                u = normalize_text(_child(pmt, "UETR").text or "").strip().lower()
                # PRD v0.7.1 C-EXT-1: the element is a candidate; UUID v4 ->
                # uetr, otherwise uetr_candidate_invalid.
                # C-EXT-1: only a UUID-shaped (8-4-4-4-12 hex) value is a
                # candidate; a value of any other shape (or empty) is not, and
                # gives neither (it is still part of the document text).
                if _UETR_FULL_RE.fullmatch(u):
                    if _uetr_valid(u):
                        uetr = u
                    else:
                        uetr_invalid = u
            items.append({"minor": minor, "currency": ccy, "value_date": vd, "uetr": uetr, "uetr_invalid": uetr_invalid})
    # PRD v0.7.3 C-ING-2: the text content of a recognised pacs.008 is
    # attachment text (rule extraction, redaction, injection check).
    # READING: the text is every element's text and tail of the whole parsed
    # file (an AppHdr envelope included), in document order, each trimmed,
    # whitespace-only pieces dropped, joined with "\n"; attribute values
    # (e.g. Ccy) are not included; the original characters are returned
    # (I-04 is applied when the text is processed).
    pieces = []
    for el in root.iter():
        for t in (el.text, el.tail if el is not root else None):
            if t and t.strip():
                pieces.append(t.strip())
    return {"parsed": True, "items": items, "text": "\n".join(pieces)}


# ---------------------------------------------------------------------------
# C-EXT-1 UETR
# ---------------------------------------------------------------------------

_HEX = "[0-9A-Fa-f]"
_UETR_BODY = "%s{8}-%s{4}-%s{4}-%s{4}-%s{12}" % ((_HEX,) * 5)
_UETR_FULL_RE = re.compile(_UETR_BODY)
# Not preceded by letter/digit/hyphen, except the allowed prefix "UETR"
# written directly before the value. ("121:" and "UETR:" end in ":" which is
# already an allowed neighbour.)
# READING: the prefix "UETR" is matched case-insensitively.
_UETR_RE = re.compile(r"(?:(?<=[Uu][Ee][Tt][Rr])|(?<![0-9A-Za-z-]))(" + _UETR_BODY + r")(?![0-9A-Za-z-])")


def _uetr_valid(u: str) -> bool:
    h = u.replace("-", "").lower()
    return h[12] == "4" and h[16] in "89ab"


def uetr(inp):
    text = normalize_text(inp["text"])
    valid, invalid = [], []
    for m in _UETR_RE.finditer(text):
        u = m.group(1).lower()
        if _uetr_valid(u):
            if u not in valid:
                valid.append(u)
        else:
            if u not in invalid:
                invalid.append(u)
    return {"uetrs": valid, "invalid": invalid, "multiple": len(valid) > 1}


# ---------------------------------------------------------------------------
# C-EXT-2 payment references
# ---------------------------------------------------------------------------


def _is_ascii_sep(c: str) -> bool:
    return ord(c) < 128 and not (c.isascii() and c.isalnum())


def _ref_upper(s: str) -> str:
    return "".join(chr(ord(c) - 32) if "a" <= c <= "z" else c for c in s)


def ref_normalize(ref: str) -> str:
    # READING: the known reference is also I-04 normalised before the
    # C-EXT-2 normalisation.
    ref = normalize_text(ref)
    return _ref_upper("".join(c for c in ref if not _is_ascii_sep(c)))


def _ref_segments(text: str):
    segs, cur = [], []
    for c in text:
        if _is_ascii_sep(c):
            if cur:
                segs.append("".join(cur))
                cur = []
        else:
            cur.append(c)
    if cur:
        segs.append("".join(cur))
    return [_ref_upper(s) for s in segs]


def references(inp):
    text = normalize_text(inp["text"])
    segs = _ref_segments(text)
    # READING: "adjacent" segments are consecutive segments regardless of how
    # many separator characters (including line breaks) lie between them.
    combos = set()
    for i in range(len(segs)):
        acc = ""
        for j in range(i, min(i + 3, len(segs))):
            acc += segs[j]
            combos.add(acc)
    matched = []
    # READING: output order = order of the known list, without duplicates.
    for k in inp["known"]:
        nk = ref_normalize(k)
        if nk and nk in combos and k not in matched:
            matched.append(k)
    return {"matched": matched}


# ---------------------------------------------------------------------------
# C-EXT-4 bank accounts
# ---------------------------------------------------------------------------

# PRD v0.7.1 C-EXT-4: IBAN shape = a country code registered in the SWIFT IBAN
# Registry (ISO 13616) + 2 digits + letters/digits, total length exactly the
# country's registered IBAN length.
# READING: the table below is written from knowledge of the SWIFT IBAN
# Registry (country code -> total IBAN length). It must be checked against
# the registry release the product uses. Dependent territories that use
# another country's code (e.g. Jersey/Guernsey/Isle of Man -> GB, French
# overseas territories -> FR, Aland -> FI) are not listed separately.
IBAN_LENGTHS = {
    "AD": 24, "AE": 23, "AL": 28, "AT": 20, "AZ": 28, "BA": 20, "BE": 16, "BG": 22,
    "BH": 22, "BI": 27, "BR": 29, "BY": 28, "CH": 21, "CR": 22, "CY": 28, "CZ": 24,
    "DE": 22, "DJ": 27, "DK": 18, "DO": 28, "EE": 20, "EG": 29, "ES": 24, "FI": 18,
    "FK": 18, "FO": 18, "FR": 27, "GB": 22, "GE": 22, "GI": 23, "GL": 18, "GR": 27,
    "GT": 28, "HN": 28, "HR": 21, "HU": 28, "IE": 22, "IL": 23, "IQ": 23, "IS": 26,
    "IT": 27, "JO": 30, "KW": 30, "KZ": 20, "LB": 28, "LC": 32, "LI": 21, "LT": 20,
    "LU": 20, "LV": 21, "LY": 25, "MC": 27, "MD": 24, "ME": 22, "MK": 19, "MN": 20,
    "MR": 27, "MT": 31, "MU": 30, "NI": 28, "NL": 18, "NO": 15, "OM": 23, "PK": 24,
    "PL": 28, "PS": 29, "PT": 25, "QA": 29, "RO": 24, "RS": 22, "RU": 33, "SA": 24,
    "SC": 31, "SD": 18, "SE": 24, "SI": 19, "SK": 24, "SM": 27, "SO": 23, "ST": 25,
    "SV": 28, "TL": 23, "TN": 24, "TR": 26, "UA": 29, "VA": 22, "VG": 24, "XK": 20,
    "YE": 30,
}

_ASCII_ALNUM = set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
_ASCII_ALPHA = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


def _iban_at(text: str, i: int):
    """IBAN shape starting at i: (end, compact upper-case value) or None."""
    n = len(text)
    if i + 1 >= n or text[i] not in _ASCII_ALPHA or text[i + 1] not in _ASCII_ALPHA:
        return None
    # READING: the shape must not touch another letter or digit (any script)
    # at either end.
    if i > 0 and text[i - 1].isalnum():
        return None
    L = IBAN_LENGTHS.get(text[i:i + 2].upper())
    if not L:
        return None

    def end_ok(e):
        return e >= n or not text[e].isalnum()

    # Solid form.
    s = text[i:i + L]
    if len(s) == L and all(c in _ASCII_ALNUM for c in s) and s[2:4].isdigit() and end_ok(i + L):
        return i + L, s.upper()
    # Grouped form: groups of 4 (the last may be shorter), one space or one
    # line break between groups.
    # PRD v0.7.3: a hyphen is also a group separator.
    # READING: a line break is "\r\n", "\n" or "\r"; a tab or two spaces is
    # not a group separator. Space, line-break and hyphen gaps may be mixed.
    pos, chars = i, []
    while True:
        k = min(4, L - len(chars))
        g = text[pos:pos + k]
        if len(g) < k or not all(c in _ASCII_ALNUM for c in g):
            return None
        chars.extend(g)
        pos += k
        if len(chars) == L:
            break
        if text.startswith("\r\n", pos):
            pos += 2
        elif pos < n and text[pos] in " \n\r-":
            pos += 1
        else:
            return None
    compact = "".join(chars)
    if not compact[2:4].isdigit() or not end_ok(pos):
        return None
    return pos, compact.upper()


def _iban_shapes(text: str):
    """All IBAN shapes as (start, end, compact), left to right, non-overlapping."""
    out, i = [], 0
    while i < len(text) - 1:
        r = _iban_at(text, i)
        if r:
            out.append((i, r[0], r[1]))
            i = r[0]
        else:
            i += 1
    return out


def _iban_mod97_ok(s: str) -> bool:
    r = s[4:] + s[:4]
    num = "".join(str(int(c, 36)) for c in r)
    return int(num) % 97 == 1


_SORT_RE = re.compile(r"(?<![0-9A-Za-z])(?<![0-9]-)(?:[0-9]{2}-[0-9]{2}-[0-9]{2}|[0-9]{6})(?![0-9A-Za-z])(?!-[0-9])")
_SORT_HYPHEN_RE = re.compile(r"(?<![0-9A-Za-z])(?<![0-9]-)[0-9]{2}-[0-9]{2}-[0-9]{2}(?![0-9A-Za-z])(?!-[0-9])")
_ACC8_RE = re.compile(r"(?<![0-9A-Za-z])[0-9]{8}(?![0-9A-Za-z])")
_DIG6_RE = re.compile(r"(?<![0-9A-Za-z])[0-9]{6}(?![0-9A-Za-z])")
_DIG9_RE = re.compile(r"(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])")


def _gap(a, b):
    """Characters between two spans (0 if touching/overlapping)."""
    if a[1] <= b[0]:
        return b[0] - a[1]
    if b[1] <= a[0]:
        return a[0] - b[1]
    return 0


def _uk_pairs(text: str):
    """C-EXT-4 UK hits: list of (sort_span, account_span)."""
    sorts = [(m.start(), m.end()) for m in _SORT_RE.finditer(text)]
    accs = [(m.start(), m.end()) for m in _ACC8_RE.finditer(text)]
    pairs = []
    # READING: "附近 30 个字符内" = at most 30 characters between the sort code
    # and the account number, on either side. Each account is paired with the
    # nearest sort code.
    for a in accs:
        best = None
        for s in sorts:
            g = _gap(s, a)
            if g <= 30 and (best is None or g < best[0]):
                best = (g, s)
        if best is not None:
            pairs.append((best[1], a))
    return pairs


def accounts(inp):
    text = normalize_text(inp["text"])
    found = []  # (pos, key, entry)
    for start, _, compact in _iban_shapes(text):
        if _iban_mod97_ok(compact):
            found.append((start, ("iban", compact), {"kind": "iban", "last4": compact[-4:], "country": compact[:2]}))
    for s, a in _uk_pairs(text):
        acc = text[a[0]:a[1]]
        # READING: for UK accounts "country" is null (the kind "uk" already
        # says the type); duplicates are by account number.
        found.append((a[0], ("uk", acc), {"kind": "uk", "last4": acc[-4:], "country": None}))
    found.sort(key=lambda x: x[0])
    out, seen = [], set()
    for _, key, entry in found:
        if key in seen:
            continue
        seen.add(key)
        out.append(entry)
    return {"accounts": out}


# ---------------------------------------------------------------------------
# C-EXT-5 dates
# ---------------------------------------------------------------------------

_MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7,
    "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8, "sep": 9,
    "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))
# READING: English month names in full or as 3-letter abbreviations (plus
# "Sept"), case-insensitive, optional "." after the name; day 1-2 digits;
# year 4 digits; a date without a year is not a date. "October 29 2026" (no
# comma) is accepted. Numeric slash dates accept 1-2 digit day and month.
# Other separators ("." "-") are not C-EXT-5 dates.
# PRD v0.7.1 C-EXT-5: the day may carry an ordinal suffix and "of" may follow
# it ("29th of October 2026"); the parts are separated by spaces or tabs,
# never by a line break.
# READING: the suffix is any of st/nd/rd/th, case-insensitive, without
# checking that it fits the number ("29st" is accepted); "of" is allowed with
# or without a suffix ("29 of October 2026"), only in the day-month order;
# one or more spaces/tabs separate parts; an optional comma may follow the
# month (DMY) or the day (MDY).
_DSEP = r"[ \t]+"
_DAY = r"([0-9]{1,2})(?:st|nd|rd|th)?"
_ISO_RE = re.compile(r"(?<![0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})(?![0-9])")
_DMY_RE = re.compile(r"(?<![0-9A-Za-z])" + _DAY + r"(?:" + _DSEP + r"of)?" + _DSEP + r"(" + _MONTH_ALT
                     + r")(?![A-Za-z])\.?,?" + _DSEP + r"([0-9]{4})(?![0-9])", re.IGNORECASE)
_MDY_RE = re.compile(r"(?<![A-Za-z])(" + _MONTH_ALT + r")(?![A-Za-z])\.?" + _DSEP + _DAY
                     + r"(?![A-Za-z0-9]),?" + _DSEP + r"([0-9]{4})(?![0-9])", re.IGNORECASE)
_SLASH_RE = re.compile(r"(?<![0-9/])([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})(?![0-9/])")
# Extra numeric shapes used only to find dates of birth for redaction.
_DOTDASH_RE = re.compile(r"(?<![0-9.\-])([0-9]{1,2})[.\-]([0-9]{1,2})[.\-]([0-9]{4})(?![0-9.\-]?[0-9])")


def _date_entry(y, m, d):
    if _valid_date(y, m, d):
        return "%04d-%02d-%02d" % (y, m, d), "ok"
    return None, "invalid"


def _date_candidates(text: str):
    cands = []
    for m in _ISO_RE.finditer(text):
        iso, st = _date_entry(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        cands.append((m.start(), m.end(), iso, st))
    for m in _DMY_RE.finditer(text):
        iso, st = _date_entry(int(m.group(3)), _MONTHS[m.group(2).lower()], int(m.group(1)))
        cands.append((m.start(), m.end(), iso, st))
    for m in _MDY_RE.finditer(text):
        iso, st = _date_entry(int(m.group(3)), _MONTHS[m.group(1).lower()], int(m.group(2)))
        cands.append((m.start(), m.end(), iso, st))
    for m in _SLASH_RE.finditer(text):
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if a > 12 and b > 12:
            iso, st = None, "invalid"
        elif a > 12:  # DD/MM
            iso, st = _date_entry(y, b, a)
        elif b > 12:  # MM/DD
            iso, st = _date_entry(y, a, b)
        elif a == b:
            # PRD v0.7.1 C-EXT-5: equal parts (03/03/2026) read the same both
            # ways -> that date.
            iso, st = _date_entry(y, a, b)
        elif a == 0 or b == 0:
            iso, st = None, "invalid"
        else:
            iso, st = None, "ambiguous"
        cands.append((m.start(), m.end(), iso, st))
    cands.sort(key=lambda c: (c[0], -(c[1] - c[0])))
    out, last = [], -1
    for c in cands:
        if c[0] >= last:
            out.append(c)
            last = c[1]
    return out


def dates(inp):
    text = normalize_text(inp["text"])
    return {"dates": [{"iso": iso, "status": st, "start": s, "end": e} for s, e, iso, st in _date_candidates(text)]}


# ---------------------------------------------------------------------------
# C-EXT-6 e-signature invitations
# ---------------------------------------------------------------------------


def _norm_domain(d: str) -> str:
    d = normalize_text(d or "").strip().lower().rstrip(".")
    if "@" in d:
        d = d.rsplit("@", 1)[1]
    return d


def esign(inp):
    platforms = inp.get("platforms") or {}
    doms = [_norm_domain(inp.get("from_domain") or "")] + [_norm_domain(x) for x in (inp.get("link_domains") or [])]
    # READING: a domain belongs to a platform when it equals one of the
    # platform's domains or is a subdomain of it; the first hit (sender domain
    # first, then links in order; platforms in configured order) names the
    # platform.
    for d in doms:
        if not d:
            continue
        for name, pdoms in platforms.items():
            for pd in pdoms:
                pd = _norm_domain(pd)
                if pd and (d == pd or d.endswith("." + pd)):
                    return {"esign_invite": True, "platform": name}
    return {"esign_invite": False, "platform": None}


# ---------------------------------------------------------------------------
# C-RED-1 redaction
# ---------------------------------------------------------------------------

_KIND_PRIORITY = {"ACCOUNT": 0, "SORTCODE": 1, "ID": 2, "DOB": 3, "ADDRESS": 4, "PHONE": 5, "EMAIL": 6, "NAME": 7}

# PRD v0.7.3: a surname shorter than 5 letters is padded with 9
# ("LEE99607058L99AB").
# READING: the first 5 characters are 1-5 letters followed by 9s (at least
# one letter, no letter after a 9).
_DL_RE = re.compile(r"(?<![0-9A-Za-z])(?:[A-Za-z]{5}|[A-Za-z]{4}9|[A-Za-z]{3}99|[A-Za-z]{2}999|[A-Za-z]9999)"
                    r"[0-9]{6}[A-Za-z0-9]{2}[A-Za-z0-9]{3}(?![0-9A-Za-z])")
_NINO_RE = re.compile(r"(?<![0-9A-Za-z])[A-Za-z]{2}[0-9]{6}[A-Za-z](?![0-9A-Za-z])")
# PRD v0.7.1: HMRC printed form "AA 99 99 99 A".
# READING: exactly one space (U+0020) between the five parts.
_NINO_PRINTED_RE = re.compile(r"(?<![0-9A-Za-z])[A-Za-z]{2} [0-9]{2} [0-9]{2} [0-9]{2} [A-Za-z](?![0-9A-Za-z])")
_POSTCODE_RE = re.compile(r"(?<![0-9A-Za-z])[A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2}(?![0-9A-Za-z])")
# C-RED-1: the whole local part is replaced, whatever RFC 5322 allows in it:
# a dot-atom of atext (letters and digits in any script, ! # $ % & ' * + / = ?
# ^ _ ` { | } ~ -) or a quoted string.
# READING: "letters and digits in any script" = Python's Unicode \w (which
# includes "_"); a quoted local part is "..." with backslash escapes and no
# line break, kept whole with its quotes. The local part must not be preceded
# by an atext character, "." or '"' (it is the longest valid local part).
# The domain is word characters and hyphens with at least one dot.
_EMAIL_ATEXT = r"[\w!#$%&'*+/=?^`{|}~\-]"
_EMAIL_RE = re.compile(r"(?<![\w!#$%&'*+/=?^`{|}~\-.\"])(" + _EMAIL_ATEXT + r"+(?:\." + _EMAIL_ATEXT + r"+)*"
                       r'|"(?:[^"\\\r\n]|\\[^\r\n])*")@([\w\-]+(?:\.[\w\-]+)+)')
_LINE_BREAKS = "\n\r\x0b\x0c\x1c\x1d\x1e\x85  "


def _kw_spans(tokens, phrases):
    out = []
    for p in phrases:
        out.extend(_phrase_spans(tokens, p))
    return out


def _after_within(kw_spans, span, n):
    """span starts within n characters after the end of any keyword."""
    return any(span[0] >= k[1] and span[0] - k[1] <= n for k in kw_spans)


def _around_within(kw_spans, span, n):
    return any((span[0] >= k[1] and span[0] - k[1] <= n) or (k[0] >= span[1] and k[0] - span[1] <= n) for k in kw_spans)


def _value_key(kind: str, s: str) -> str:
    # READING: "同一值" is compared after removing formatting: accounts, sort
    # codes and IDs ignore whitespace/hyphens and case; phones keep only "+"
    # and digits; emails and names ignore case; dates of birth and addresses
    # ignore case and collapse whitespace.
    if kind in ("ACCOUNT", "SORTCODE", "ID"):
        return "".join(c for c in s if c.isalnum()).upper()
    if kind == "PHONE":
        # READING: "+44 (0)20 ...", "+44 20 ..." and "0044 20 ..." are the
        # same value.
        s = s.replace("(0)", "")
        if s.startswith("00"):
            s = "+" + s[2:]
        return "".join(c for c in s if c.isdigit() or c == "+")
    if kind in ("EMAIL", "NAME"):
        return s.casefold()
    return " ".join(s.split()).casefold()


def _lines(text: str):
    """(start, end) of each line; "\r\n" is one line break."""
    out, ls, i, n = [], 0, 0, len(text)
    while i < n:
        c = text[i]
        if c in _LINE_BREAKS:
            out.append((ls, i))
            i += 2 if c == "\r" and i + 1 < n and text[i + 1] == "\n" else 1
            ls = i
        else:
            i += 1
    out.append((ls, n))
    return out


def _phone_at(text: str, i: int):
    """End of a phone starting at i, or None (C-RED-1)."""
    # READING (v0.7.1-v0.7.3): a phone starts with "+", "00" (international
    # prefixes, not counted, followed directly by the country code), "0", or
    # "(0" (a bracketed national area code such as "(020)"). It is a series of
    # items: digit runs, or digits in brackets. Brackets are allowed only as
    # the first item of a national number or as the item right after the
    # country code; there "(0)" is not counted, any other bracketed area code
    # is ("+1 (212) 555 0100"). Items are separated by one space or one
    # hyphen; a bracket may also touch the next/previous item. The start must
    # not be preceded by a letter, digit or "+".
    # PRD v0.7.2: the phone ends at the first item end where the digit count
    # is 10-15; it must not be followed there by a letter or digit. No such
    # point -> no phone. Starts are tried at every position from left to
    # right; a rejected start consumes nothing (fixes "£0.50 07700900123").
    n = len(text)
    if i > 0 and (text[i - 1].isalnum() or text[i - 1] == "+"):
        return None
    c = text[i]
    if c == "+":
        intl, pos = True, i + 1
    elif text.startswith("00", i):
        intl, pos = True, i + 2
    elif c == "0" or (c == "(" and i + 1 < n and text[i + 1] == "0"):
        intl, pos = False, i
    else:
        return None
    if intl and not (pos < n and text[pos].isdigit()):
        return None
    items, cnt = 0, 0
    while True:
        if pos < n and text[pos].isdigit():
            q = pos
            while q < n and text[q].isdigit():
                q += 1
            cnt += q - pos
            pos = q
        elif pos < n and text[pos] == "(" and ((not intl and items == 0) or (intl and items == 1)):
            m = re.compile(r"\(([0-9]+)\)").match(text, pos)
            if not m:
                return None
            d = m.group(1)
            if not intl and not d.startswith("0"):
                return None
            if not (intl and d == "0"):
                cnt += len(d)
            pos = m.end()
        else:
            return None
        items += 1
        if 10 <= cnt <= 15:
            return None if (pos < n and text[pos].isalnum()) else pos
        if cnt > 15:
            return None
        # next item: glued after/before a bracket, or after one space/hyphen
        if pos < n and (text[pos] == "(" or (text[pos].isdigit() and text[pos - 1] == ")")):
            continue
        if pos + 1 < n and text[pos] in " -" and (text[pos + 1].isdigit() or text[pos + 1] == "("):
            pos += 1
            continue
        return None


def redact_spans(text: str, contact_names):
    """Return merged spans [(start, end, kind)] over already-normalised text."""
    toks = _tokens(text)
    cands = []  # (start, end, kind)

    # 1. IBAN shapes (any check digits) -> ACCOUNT (covers valid IBANs of C-EXT-4)
    for s, e, _ in _iban_shapes(text):
        cands.append((s, e, "ACCOUNT"))

    # 2. sort codes and 8-digit account numbers
    sort_kw = _kw_spans(toks, ["sort", "sort code"])
    sortcode_kw = _kw_spans(toks, ["sort code"])
    # READING: the account keywords are matched as I-05 whole words
    # ("accounts" does not count; "a/c" is the word sequence a, c).
    acc_kw = _kw_spans(toks, ["account", "acc", "a/c"])
    for m in _SORT_HYPHEN_RE.finditer(text):
        cands.append((m.start(), m.end(), "SORTCODE"))
    for m in _DIG6_RE.finditer(text):
        # READING: "一词后 N 个字符内" = the number starts at most N characters
        # after the end of the keyword.
        if _after_within(sort_kw, (m.start(), m.end()), 20):
            cands.append((m.start(), m.end(), "SORTCODE"))
    for m in _ACC8_RE.finditer(text):
        sp = (m.start(), m.end())
        if _after_within(acc_kw, sp, 30) or _around_within(sortcode_kw, sp, 30):
            cands.append((sp[0], sp[1], "ACCOUNT"))
    # union with the C-EXT-4 UK hits
    for s, a in _uk_pairs(text):
        cands.append((s[0], s[1], "SORTCODE"))
        cands.append((a[0], a[1], "ACCOUNT"))

    # 3. IDs
    passport_kw = _kw_spans(toks, ["passport"])
    for m in _DIG9_RE.finditer(text):
        if _around_within(passport_kw, (m.start(), m.end()), 30):
            cands.append((m.start(), m.end(), "ID"))
    for rx in (_DL_RE, _NINO_RE, _NINO_PRINTED_RE):
        for m in rx.finditer(text):
            cands.append((m.start(), m.end(), "ID"))

    # 4. dates of birth
    # PRD v0.7.3: "D.O.B." is a keyword too (I-05: the words d, o, b).
    dob_kw = _kw_spans(toks, ["born", "dob", "d.o.b.", "date of birth"])
    # READING: any C-EXT-5 date shape (whatever its status), plus numeric
    # dates written with "." or "-" (01.02.1980, 01-02-1980), whose start is
    # at most 30 characters after the end of the keyword.
    date_spans = [(s, e) for s, e, _, _ in _date_candidates(text)]
    date_spans += [(m.start(), m.end()) for m in _DOTDASH_RE.finditer(text)]
    for sp in date_spans:
        if _after_within(dob_kw, sp, 30):
            cands.append((sp[0], sp[1], "DOB"))

    # 5. UK postcode, its line, and up to 3 non-empty lines directly above
    # (PRD v0.7.3), stopping at an empty line.
    # READING: lines are separated by line breaks ("\r\n" counts as one);
    # a line of only whitespace is empty. The postcode line and the lines
    # above it form one span (one [ADDRESS_n]) from the first non-space
    # character of the top line to the last non-space character of the
    # postcode line.
    lines = _lines(text)
    for m in _POSTCODE_RE.finditer(text):
        li = next(k for k, (ls, le) in enumerate(lines) if ls <= m.start() <= le)
        top = li
        while top > 0 and li - top < 3 and text[lines[top - 1][0]:lines[top - 1][1]].strip():
            top -= 1
        ls, le = lines[top][0], lines[li][1]
        while ls < le and text[ls].isspace():
            ls += 1
        while le > ls and text[le - 1].isspace():
            le -= 1
        cands.append((ls, le, "ADDRESS"))

    # 6. phone numbers
    i = 0
    while i < len(text):
        r = _phone_at(text, i)
        if r:
            cands.append((i, r, "PHONE"))
            i = r
        else:
            i += 1

    # 7. email local parts
    email_domains = []
    for m in _EMAIL_RE.finditer(text):
        cands.append((m.start(1), m.end(1), "EMAIL"))
        email_domains.append((m.start(2), m.end(2)))

    # 8. contact names
    words = set()
    for name in contact_names or []:
        nn = normalize_text(name)
        for s0, e0, w in _tokens(nn):
            # PRD v0.7.17: «长度按写出的字符数算、附加符也算». READING: the length
            # is the number of code points of the word as written after I-04
            # (NFKC), marks included, before casefold: "राम" (र + ा + म) is 3.
            if e0 - s0 >= 3 and w:
                words.add(w)
    for s, e, w in toks:
        if w in words:
            # READING: the domain of an email address is kept (C-RED-1 "保留
            # 域名"), so a name word inside an email domain is not replaced.
            if any(s < de and e > ds for ds, de in email_domains):
                continue
            cands.append((s, e, "NAME"))

    # PRD v0.7.3: a value found sensitive by any rule is replaced at every
    # occurrence in the text, near a keyword or not.
    # READING: an occurrence is the same character sequence (case-insensitive)
    # that does not touch a letter or digit at either end. EMAIL and NAME are
    # left out: the value of an email is the whole address, which the email
    # rule already finds everywhere, and names are matched everywhere anyway
    # (a bare local part such as "info" elsewhere is not replaced).
    low = text.casefold() if len(text.casefold()) == len(text) else None
    for s0, e0, k in list(cands):
        if k in ("EMAIL", "NAME") or s0 >= e0:
            continue
        val = text[s0:e0]
        hay, needle = (low, val.casefold()) if low is not None else (text, val)
        start = 0
        while True:
            f = hay.find(needle, start)
            if f < 0:
                break
            g = f + len(needle)
            if not (f > 0 and text[f - 1].isalnum() and text[f].isalnum()) and \
               not (g < len(text) and text[g].isalnum() and text[g - 1].isalnum()):
                if (f, g) != (s0, e0):
                    cands.append((f, g, k))
            start = f + 1

    # Union of all hits; overlapping hits are merged into one span whose kind
    # is the earliest kind in the C-RED-1 rule order.
    # READING: overlap (sharing at least one character) merges; touching spans
    # stay separate. Merged kind = first in ACCOUNT, SORTCODE, ID, DOB,
    # ADDRESS, PHONE, EMAIL, NAME.
    cands.sort(key=lambda c: (c[0], c[1]))
    merged = []
    for s, e, k in cands:
        if s >= e:
            continue
        if merged and s < merged[-1][1]:
            ps, pe, pk = merged[-1]
            nk = pk if _KIND_PRIORITY[pk] <= _KIND_PRIORITY[k] else k
            merged[-1] = (ps, max(pe, e), nk)
        else:
            merged.append((s, e, k))
    return merged


def redact(inp):
    text = normalize_text(inp["text"])
    spans = redact_spans(text, inp.get("contact_names") or [])
    counters, assigned = {}, {}
    parts, pos = [], 0
    out_spans = []
    for s, e, k in spans:
        key = (k, _value_key(k, text[s:e]))
        if key not in assigned:
            counters[k] = counters.get(k, 0) + 1
            assigned[key] = counters[k]
        parts.append(text[pos:s])
        parts.append("[%s_%d]" % (k, assigned[key]))
        pos = e
        out_spans.append({"start": s, "end": e, "kind": k})
    parts.append(text[pos:])
    return {"spans": out_spans, "text": "".join(parts)}


# ---------------------------------------------------------------------------
# C-LNK-3 name similarity
# ---------------------------------------------------------------------------

_NAME_STOP = {"MR", "MRS", "MS", "DR", "LTD", "LIMITED", "LLP", "PLC", "AND", "THE"}


def _name_words(s: str):
    # READING: I-04 is applied to names first (C-SIG-1.3 compares the
    # normalised display name, TC-SIG-08).
    s = _ref_upper(normalize_text(s))
    words, cur = [], []
    for c in s:
        if ord(c) < 128 and not ("A" <= c <= "Z"):
            if cur:
                words.append("".join(cur))
                cur = []
        else:
            cur.append(c)
    if cur:
        words.append("".join(cur))
    return [w for w in words if w not in _NAME_STOP]


def _words_match(a: str, b: str) -> bool:
    if a == b:
        return True
    if len(a) == 1 and b.startswith(a):
        return True
    if len(b) == 1 and a.startswith(b):
        return True
    return False


def _max_matching(A, B) -> int:
    match_b = [-1] * len(B)

    def try_a(i, seen):
        for j in range(len(B)):
            if not seen[j] and _words_match(A[i], B[j]):
                seen[j] = True
                if match_b[j] == -1 or try_a(match_b[j], seen):
                    match_b[j] = i
                    return True
        return False

    return sum(1 for i in range(len(A)) if try_a(i, [False] * len(B)))


def name_similarity_pair(a: str, b: str):
    A, B = _name_words(a), _name_words(b)
    if not A or not B:
        # READING: "任一方没有词则相似度为 0" is reported as 0/0.
        return 0, 0
    return _max_matching(A, B), max(len(A), len(B))


def name_similarity(inp):
    num, den = name_similarity_pair(inp["a"], inp["b"])
    return {"num": num, "den": den}


# ---------------------------------------------------------------------------
# C-SIG-1 signals
# ---------------------------------------------------------------------------

INJECTION_PHRASES = [
    "ignore previous", "ignore all", "ignore the above", "disregard", "system prompt",
    "you are an ai", "as an ai", "new instructions", "classify this as", "mark this as low",
    "do not flag",
    # PRD v0.7.21 (C-SIG-1.8): four phrases added; "system note" and the bare
    # "to the assistant" are not on the list (§9 v0.7.21, review F6).
    "note to assistant", "note to the assistant", "instructions to the assistant", "choose template",
]

_FAIL_RESULTS = {"fail", "softfail", "permerror"}


def _email_norm(addr) -> str:
    if not addr:
        return ""
    addr = normalize_text(addr).strip()
    if "<" in addr:
        addr = parseaddr(addr)[1] or addr
    # I-03: compare domain and local part in lower case
    return addr.lower()


def _domain_of(addr: str) -> str:
    return addr.rsplit("@", 1)[1] if "@" in addr else ""


def _ar_tokens(v: str) -> str:
    """Authentication-Results value with comments removed and quoted strings blanked.

    READING (RFC 8601 / RFC 5322): a comment is "(" ... ")" and may nest;
    inside a comment a quote is ordinary text and a backslash escapes the next
    character. Outside comments, a quoted string "..." (with backslash
    escapes) is a single value: its content, including any ";", "=" or "(",
    is not part of the result syntax; it is replaced by an empty quoted
    string. Comments are replaced by a space.
    """
    out, i, n = [], 0, len(v)
    while i < n:
        c = v[i]
        if c == "(":
            depth, i = 1, i + 1
            while i < n and depth:
                if v[i] == "\\":
                    i += 2
                    continue
                if v[i] == "(":
                    depth += 1
                elif v[i] == ")":
                    depth -= 1
                i += 1
            out.append(" ")
        elif c == '"':
            i += 1
            while i < n and v[i] != '"':
                i += 2 if v[i] == "\\" else 1
            i += 1
            out.append('""')
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _parse_auth_results(value: str):
    """Return (authserv_id, {method: [results]}) for an Authentication-Results value."""
    v = _ar_tokens(normalize_text(value).replace("\r\n", " ").replace("\n", " "))
    parts = v.split(";")
    head = parts[0].strip().split()
    authserv = head[0].lower() if head else ""
    results = {}
    for seg in parts[1:]:
        # READING: each resinfo starts with "method[/version]=result"; the
        # rest of the segment (reason, properties) is ignored.
        m = re.match(r"\s*([A-Za-z0-9_.\-]+)(?:\s*/\s*[0-9]+)?\s*=\s*([A-Za-z0-9_\-]+)", seg)
        if m:
            results.setdefault(m.group(1).lower(), []).append(m.group(2).lower())
    return authserv, results


def _auth(sig):
    trusted = (sig.get("trusted_authserv_id") or "").strip().lower()
    headers = sig.get("headers") or []
    untrusted = False
    adopted = None
    for name, value in headers:
        if name.strip().lower() != "authentication-results":
            continue
        authserv, results = _parse_auth_results(value)
        # READING: authserv-id is compared case-insensitively; a header
        # without a parsable authserv-id counts as untrusted.
        if not trusted or authserv != trusted:
            untrusted = True
        elif adopted is None:
            adopted = results  # topmost header with the trusted id
    adapter = sig.get("adapter")
    # Adopted only for gmail / graph / imap when the deployment declares that
    # foreign Authentication-Results headers are stripped; never for .eml.
    usable = adapter in ("gmail", "graph", "imap") and bool(sig.get("mailbox_strips_auth_results"))
    if not usable or adopted is None:
        return "unknown", False, untrusted, False
    fail = any(r in _FAIL_RESULTS for meth in ("spf", "dkim", "dmarc") for r in adopted.get(meth, []))
    # READING: with several results for one method (e.g. two DKIM
    # signatures) any failing one counts as a failure; dmarc_pass needs a
    # dmarc=pass result and no dmarc failure.
    # READING: several results for one method that disagree are not a pass:
    # dmarc_pass needs at least one dmarc result and every dmarc result
    # "pass" (dmarc=pass with dmarc=none is not a pass).
    dmarc = adopted.get("dmarc", [])
    dmarc_pass = bool(dmarc) and all(r == "pass" for r in dmarc)
    # READING: auth = "pass" whenever an adopted result exists and nothing
    # failed (even if dmarc is none/absent); dmarc_pass is reported separately.
    return ("fail" if fail else "pass"), fail, untrusted, dmarc_pass


# --- lookalike domains ----------------------------------------------------

# C-SIG-1.4: UTS #39 skeleton with the full Unicode confusables data
# (data/unicode/confusables.txt, Unicode 16.0.0, Unicode License v3):
# skeleton(X) = NFD(map each character of NFD(X) to its prototype).
CONFUSABLES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data", "unicode", "confusables.txt")
_CONFUSABLES = None


def _load_confusables():
    global _CONFUSABLES
    if _CONFUSABLES is None:
        table = {}
        with open(CONFUSABLES_PATH, encoding="utf-8-sig") as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if not line:
                    continue
                src, dst = [x.strip() for x in line.split(";")[:2]]
                table["".join(chr(int(h, 16)) for h in src.split())] = "".join(chr(int(h, 16)) for h in dst.split())
        _CONFUSABLES = table
    return _CONFUSABLES


def _skeleton(d: str) -> str:
    # READING: domains are lower-cased (and xn-- labels decoded) before the
    # skeleton, as in the rest of C-SIG-1.4; the skeleton itself follows
    # UTS #39 exactly (it may contain capitals, e.g. "0" -> "O").
    table = _load_confusables()
    x = unicodedata.normalize("NFD", d)
    x = "".join(table.get(c, c) for c in x)
    return unicodedata.normalize("NFD", x)


def _visual_fold(d: str) -> str:
    # PRD table: 0->o, 1->l, i->l, rn->m, vv->w (multi-letter first)
    d = d.replace("rn", "m").replace("vv", "w")
    return d.replace("0", "o").replace("1", "l").replace("i", "l")


def _has_non_latin(d: str) -> bool:
    # READING: "非拉丁字符" = any letter whose Unicode name does not start with
    # "LATIN" (digits, "-" and "." are script-neutral).
    for c in d:
        if unicodedata.category(c)[0] == "L":
            try:
                if not unicodedata.name(c).startswith("LATIN"):
                    return True
            except ValueError:
                return True
    return False


def _damerau_levenshtein(a: str, b: str) -> int:
    # READING: unrestricted Damerau-Levenshtein (adjacent transpositions,
    # Lowrance-Wagner), not optimal string alignment.
    INF = len(a) + len(b)
    da = {}
    d = [[0] * (len(b) + 2) for _ in range(len(a) + 2)]
    d[0][0] = INF
    for i in range(len(a) + 1):
        d[i + 1][0] = INF
        d[i + 1][1] = i
    for j in range(len(b) + 1):
        d[0][j + 1] = INF
        d[1][j + 1] = j
    for i in range(1, len(a) + 1):
        db = 0
        for j in range(1, len(b) + 1):
            i1 = da.get(b[j - 1], 0)
            j1 = db
            cost = 1
            if a[i - 1] == b[j - 1]:
                cost = 0
                db = j
            d[i + 1][j + 1] = min(
                d[i][j] + cost,
                d[i + 1][j] + 1,
                d[i][j + 1] + 1,
                d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1),
            )
        da[a[i - 1]] = i
    return d[len(a) + 1][len(b) + 1]


def _decode_idna(d: str) -> str:
    # READING: punycode labels ("xn--") are decoded before comparison.
    labels = []
    for lab in d.split("."):
        if lab.startswith("xn--"):
            try:
                lab = lab[4:].encode("ascii").decode("punycode")
            except Exception:
                pass
        labels.append(lab)
    return ".".join(labels)


def _strip_www(d: str) -> str:
    return d[4:] if d.startswith("www.") else d


def lookalike(from_domain: str, contact_domains) -> bool:
    fd = _decode_idna(from_domain.lower())
    cds = {_decode_idna(c.lower()) for c in contact_domains if c}
    if not fd or fd in cds:
        return False
    f = _strip_www(fd)
    for c in cds:
        c2 = _strip_www(c)
        if f == c2:
            # READING: same domain apart from "www." is not a lookalike.
            continue
        dist = _damerau_levenshtein(f, c2)
        if 1 <= dist <= 2:
            return True
        if _visual_fold(f) == _visual_fold(c2):
            return True
        if _has_non_latin(f) and _skeleton(f) == _skeleton(c2):
            return True
    return False


# --- hidden text ----------------------------------------------------------

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
         "source", "track", "wbr", "keygen", "command"}
# READING: text in script, style and title is not body text (code, or the
# window title) and is ignored. Other elements the browser does not show are
# handled by the default style sheet below (v0.7.3).
_NO_TEXT = {"script", "style", "title"}
# PRD v0.7.3 (clarified): styles from the browser's default style sheet count,
# e.g. the "hidden" attribute.
# READING: the part of the HTML Standard's default style sheet that hides
# content: [hidden] (any value, incl. "until-found"), head, template,
# datalist, noembed, noframes, rp, and dialog without "open" -> display:none;
# inside a <details> without "open", everything except its first <summary>
# child is not shown. These default rules have the lowest priority: an
# author style ("display:block" in a sheet or inline) overrides them, as in a
# browser; the closed-<details> rule is not overridable. <noscript> is shown
# (mail clients run no scripts).
_UA_HIDDEN_TAGS = {"head", "template", "datalist", "noembed", "noframes", "rp"}
_COLOR_NAMES = {
    "white": "#ffffff", "black": "#000000", "red": "#ff0000", "green": "#008000", "blue": "#0000ff",
    "yellow": "#ffff00", "gray": "#808080", "grey": "#808080", "silver": "#c0c0c0", "lime": "#00ff00",
    "navy": "#000080", "orange": "#ffa500", "purple": "#800080", "teal": "#008080",
    "maroon": "#800000", "olive": "#808000", "aqua": "#00ffff", "fuchsia": "#ff00ff",
    "whitesmoke": "#f5f5f5", "snow": "#fffafa", "ivory": "#fffff0",
}
_COLOR_TOKEN_RE = re.compile(r"#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b[a-z]+\b")


def _norm_color(v):
    if v is None:
        return None
    v = v.strip().lower().replace("!important", "").strip()
    if not v:
        return None
    # PRD v0.7.3: "transparent" text is hidden.
    # READING: a colour with alpha 0 (rgba(...,0), #rrggbb00, #rgb0) is
    # transparent too.
    if v == "transparent":
        return "transparent"
    m = re.fullmatch(r"#([0-9a-f]{3})(0)?", v)
    if m:
        return "transparent" if m.group(2) else "#" + "".join(c * 2 for c in m.group(1))
    m = re.fullmatch(r"#([0-9a-f]{6})(ff|00)?", v)
    if m:
        return "transparent" if m.group(2) == "00" else "#" + m.group(1)
    m = re.fullmatch(r"rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*(?:,\s*([0-9]*\.?[0-9]+%?)\s*)?\)", v)
    if m:
        alpha = m.group(4)
        if alpha is not None and float(alpha.rstrip("%")) == 0:
            return "transparent"
        return "#%02x%02x%02x" % tuple(min(255, int(x)) for x in m.groups()[:3])
    if v in _COLOR_NAMES:
        return _COLOR_NAMES[v]
    return v


def _bg_from_shorthand(v):
    v = v.lower()
    for t in _COLOR_TOKEN_RE.findall(v):
        if t.startswith("#") or t.startswith("rgb") or t in _COLOR_NAMES:
            return _norm_color(t)
    return None


# READING (PRD v0.7.7): a CSS number: optional sign, digits with an optional
# fraction, optional exponent ("-0", "+0", ".0", "0e3").
_CSS_NUM = r"[+-]?(?:[0-9]*\.)?[0-9]+(?:e[+-]?[0-9]+)?"

_FONT_PREFIX_WORDS = {"normal", "italic", "oblique", "small-caps", "bold", "bolder", "lighter",
                      "ultra-condensed", "extra-condensed", "condensed", "semi-condensed",
                      "semi-expanded", "expanded", "extra-expanded", "ultra-expanded"}


_INVALID = object()

_SYSTEM_FONTS = {"caption", "icon", "menu", "message-box", "small-caption", "status-bar"}
# READING (CSS Fonts): absolute and relative font-size keywords.
_FONT_SIZE_WORDS = {"xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large",
                    "xxx-large", "larger", "smaller"}
# READING (CSS Values): length units and "%". A number without a unit is a
# size only when it is 0 (non-zero unitless numbers are weights, above).
_CSS_LEN_UNITS = ("px|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|rlh|cm|mm|q|in|pt|pc|"
                  "vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|svmin|svmax|lvmin|lvmax|"
                  "dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|%")


def _negative_size(v: str) -> bool:
    """A number below zero, with or without a unit ("-1px", "-.5em", "-1")."""
    m = re.fullmatch("(" + _CSS_NUM + r")\s*([a-z%]*)", v.strip())
    return bool(m) and float(m.group(1)) < 0


def _font_shorthand_size(v: str):
    """Font size set by the "font" shorthand (a system font keyword counts as
    a size that hides nothing); None (nothing after the prefix words) or
    _INVALID (no valid or a negative size) set none."""
    # READING (C-SIG-1.7, CSS Fonts): "font: [style || variant || weight ||
    # stretch]? size[/line-height] family". Tokens before the size are those
    # keywords or a unitless weight (1-1000); the first other token, cut at
    # "/", is the size. A unitless "0" is a size, not a weight.
    # PRD v0.7.7: a size whose numeric value is 0 is 0 however it is written
    # ("0", "0.0", ".0", "00", "-0"); such a unitless number is a size.
    # PRD v0.7.7: a negative size is not valid CSS; READING: the whole
    # shorthand is then invalid and is dropped (returned as _INVALID). A
    # negative unitless number is no valid weight either, so it counts too.
    # READING (CSS Fonts): a system font keyword alone ("font: caption") is a
    # valid shorthand and sets the system's size, which hides nothing; it is
    # kept as a size so it still overrides an earlier one.
    if v.strip() in _SYSTEM_FONTS:
        return v.strip()
    for tok in v.split():
        size = tok.split("/", 1)[0]
        if not size:
            return None
        if _negative_size(size):
            return _INVALID
        if size in _FONT_PREFIX_WORDS or (re.fullmatch(_CSS_NUM, size) and float(size) != 0):
            continue
        # READING (owner/coordinator, after Codex round 5): the first other
        # token must be a valid font size, else the shorthand has no size,
        # is invalid CSS and is dropped like a negative one ("font:bold
        # Arial" leaves an earlier font-size in effect). Valid: a size
        # keyword, a number with a length unit or %, or a zero. A token with
        # a function ("calc(", "var(") is outside the evaluated scope (PRD
        # v0.7.6) and keeps the old treatment: a size that hides nothing.
        if size in _FONT_SIZE_WORDS or "(" in size or re.fullmatch(
                "(" + _CSS_NUM + ")(?:" + _CSS_LEN_UNITS + ")?", size):
            return size
        return _INVALID
    return None


_IMPORTANT_RE = re.compile(r"!\s*important\s*$")


def _parse_decls(s: str):
    """Declarations in written order: [(property, value, important)].

    PRD v0.7.4 C-SIG-1.7: a shorthand and its longhand ("font" / "font-size",
    "background" / "background-color"): the later one written wins.
    READING: shorthands are expanded into the longhand they set, as CSS does,
    and then take part in the cascade like the longhand. "font" sets
    font-size only when a size can be read (a system font such as "caption"
    sets none here). "background" always sets background-color: its colour
    token, or the initial value "transparent" when it has none (so
    "background:url(x)" after "background-color:#000" resets the colour,
    and a transparent background keeps the inherited one).
    """
    out = []
    for decl in (s or "").split(";"):
        if ":" not in decl:
            continue
        k, v = decl.split(":", 1)
        k = k.strip().lower()
        v = v.strip().lower()
        imp = bool(_IMPORTANT_RE.search(v))
        if imp:
            v = _IMPORTANT_RE.sub("", v).strip()
        # PRD v0.7.7: a negative font size is not valid CSS and has no
        # effect. READING: as in CSS, an invalid declaration is dropped when
        # it is parsed, so it takes no part in the cascade and an earlier or
        # lower-priority valid size stays in effect. A "font" shorthand with
        # a negative size is invalid as a whole.
        if k == "font":
            size = _font_shorthand_size(v)
            if size is not None and size is not _INVALID:
                out.append(("font-size", size, imp))
        elif k == "font-size" and _negative_size(v):
            continue
        elif k == "background":
            out.append(("background-color", _bg_from_shorthand(v) or "transparent", imp))
        else:
            out.append((k, v, imp))
    return out


def _font_size_hidden(v: str) -> bool:
    # READING: font-size hides text when it is 0 in any unit, or <= 1 when
    # given in px (or without a unit). PRD v0.7.7: a numeric value of 0 is 0
    # however written ("-0", "0.0", ".0", "00"). PRD v0.7.7: a negative
    # non-zero size is invalid CSS; _parse_decls already drops it, and it
    # hides nothing here either.
    m = re.fullmatch("(" + _CSS_NUM + r")\s*([a-z%]*)", v.strip())
    if not m:
        return False
    num, unit = float(m.group(1)), m.group(2)
    if num == 0:
        return True
    return num > 0 and unit in ("", "px") and num <= 1


def _opacity_hidden(v: str) -> bool:
    # PRD v0.7.3: opacity:0. READING: "0", "0.0", "0%" (any zero value).
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)%?", v.strip())
    return bool(m) and float(m.group(1)) == 0


# --- style sheets (PRD v0.7.3: "不论样式写在元素上还是样式表里") ---------------
# READING: a small CSS subset. Rules from every <style> element in the HTML
# apply to the whole document (wherever the <style> sits). Supported
# selectors: type, "*", .class, #id, compounds of these, the descendant
# (space) and child (">") combinators, comma lists. A selector with anything
# else (attributes, pseudo-classes, "+", "~") is ignored.
# PRD v0.7.4: rules inside an unconditional @media (query all / screen /
# only screen; one such query in a comma list is enough), @supports and
# @layer blocks count; conditional @media (max-width, print, ...) and every
# other at-rule block (@font-face, @keyframes, @page, ...) do not.
# Cascade (PRD v0.7.4): !important first, then inline style, then selector
# specificity (ids, classes, types), then the later rule.
_COMPOUND_RE = re.compile(r"^(\*|[a-z][a-z0-9-]*)?((?:[.#][a-z0-9_-]+)*)$", re.IGNORECASE)


def _strip_css_comments(css: str) -> str:
    css = re.sub(r"/\*.*?\*/", " ", css, flags=re.DOTALL)
    return css.replace("<!--", " ").replace("-->", " ")


def _parse_selector(sel: str):
    """[(combinator, (tag, id, classes))] right to left is computed by the matcher; None if unsupported."""
    sel = sel.strip()
    if not sel:
        return None
    sel = re.sub(r"\s*>\s*", " > ", sel)
    parts, comb = [], " "
    for tok in sel.split():
        if tok == ">":
            comb = ">"
            continue
        m = _COMPOUND_RE.match(tok)
        if not m or not tok:
            return None
        tag = (m.group(1) or "*").lower()
        ids = re.findall(r"#([a-z0-9_-]+)", m.group(2), re.IGNORECASE)
        classes = re.findall(r"\.([a-z0-9_-]+)", m.group(2), re.IGNORECASE)
        if len(ids) > 1:
            return None
        parts.append((comb, tag, ids[0] if ids else None, frozenset(classes)))
        comb = " "
    if not parts:
        return None
    spec = (sum(1 for p in parts if p[2]), sum(len(p[3]) for p in parts), sum(1 for p in parts if p[1] != "*"))
    return parts, spec


_MEDIA_OK = {"all", "screen", "only screen"}


def _at_rule_counts(prelude: str) -> bool:
    """Whether the rules inside this at-rule block count (PRD v0.7.4)."""
    m = re.match(r"@([a-z-]+)\s*(.*)$", prelude.strip(), re.IGNORECASE | re.DOTALL)
    if not m:
        return False
    name, rest = m.group(1).lower(), m.group(2)
    if name in ("supports", "layer"):
        # READING: any @supports condition counts (the PRD lists @supports
        # without conditions). @layer blocks count; their cascade order is
        # handled by _Layers (PRD v0.7.5).
        return True
    if name == "media":
        queries = [" ".join(q.lower().split()) for q in rest.split(",")]
        # READING: an empty query list ("@media {...}") is "all" in CSS and
        # counts as unconditional.
        if queries == [""]:
            return True
        return any(q in _MEDIA_OK for q in queries)
    return False


class _Layers:
    """Cascade layer tree (PRD v0.7.5 C-SIG-1.7).

    PRD v0.7.5: normal declarations: rules in no @layer beat every layered
    rule, and between layers the later one wins; !important declarations
    the other way round (layered beats unlayered, the earlier layer wins).
    Layer order is the order in which a name first appears (including
    statements such as "@layer a, b;"). A nested layer (a.b) is ordered
    inside its parent, and the parent's own rules beat its sub-layers (as
    unlayered rules beat all layers). Every nameless "@layer { }" is a layer
    of its own. Within one layer: specificity, then the later rule.
    READING: this is the CSS Cascade 5 order. The normal-declaration rank of
    a layer is its position in a post-order walk of the tree (sub-layers in
    order of first appearance, then the layer's own rules; the root holds
    the unlayered rules and comes last); !important declarations use the
    negated rank, which reverses the whole order.
    """

    def __init__(self):
        self.children = {(): []}  # path -> child paths in order of first appearance
        self.anon = 0

    def declare(self, parent, name):
        """Path of layer `name` (dotted, or None for a nameless layer) inside `parent`."""
        if name is None:
            self.anon += 1
            names = [("#anon", self.anon)]
        else:
            names = [x.strip() for x in name.split(".")]
        path = parent
        for nm in names:
            child = path + (nm,)
            if child not in self.children:
                self.children[child] = []
                self.children[path].append(child)
            path = child
        return path

    def ranks(self):
        out = {}

        def walk(path):
            for c in self.children[path]:
                walk(c)
            out[path] = len(out)
        walk(())
        return out


# READING: a layer name is an identifier (or a dotted list of them),
# compared case-sensitively, as CSS identifiers are.
_LAYER_NAME_RE = re.compile(r"^-?[a-z_][a-z0-9_-]*(?:\s*\.\s*-?[a-z_][a-z0-9_-]*)*$", re.IGNORECASE)


def _layer_statement(stmt: str, layers, cur):
    """Declare the layers named by a statement at-rule ("@layer a, b.c;",
    "@import url(x) layer(a);")."""
    m = re.match(r"@layer\b\s*(.*)$", stmt, re.IGNORECASE | re.DOTALL)
    if m:
        for nm in m.group(1).split(","):
            nm = nm.strip()
            if _LAYER_NAME_RE.match(nm):
                layers.declare(cur, nm)
        return
    m = re.match(r"@import\b.*?\blayer\(\s*([^)]*?)\s*\)", stmt, re.IGNORECASE | re.DOTALL)
    if m and _LAYER_NAME_RE.match(m.group(1)):
        # READING: "@import ... layer(a)" declares layer a at that point (its
        # imported rules are not available to the oracle).
        layers.declare(cur, m.group(1))


def _parse_css(css: str):
    """List of (parts, specificity, order, declarations, layer rank)."""
    rules = []
    layers = _Layers()
    _parse_css_block(_strip_css_comments(css), rules, layers, ())
    ranks = layers.ranks()
    return [(parts, spec, order, decls, ranks[path]) for parts, spec, order, decls, path in rules]


def _parse_css_block(css: str, rules, layers, cur):
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0:
            # trailing statement at-rules still declare layers
            for stmt in css[i:].split(";"):
                if stmt.strip().startswith("@"):
                    _layer_statement(stmt.strip(), layers, cur)
            break
        prelude = css[i:j].strip()
        # matching close brace (nested for at-rules)
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{":
                depth += 1
            elif css[k] == "}":
                depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        i = k
        # statement at-rules ("@import ...;", "@layer a, b;") may precede the
        # prelude; @layer / @import layer() statements declare layer order.
        if ";" in prelude and prelude.lstrip().startswith("@"):
            stmts = prelude.split(";")
            for stmt in stmts[:-1]:
                if stmt.strip().startswith("@"):
                    _layer_statement(stmt.strip(), layers, cur)
            prelude = stmts[-1].strip()
        if prelude.startswith("@"):
            if _at_rule_counts(prelude):
                inner = cur
                m = re.match(r"@layer\b\s*(.*)$", prelude, re.IGNORECASE | re.DOTALL)
                if m:
                    nm = m.group(1).strip()
                    if not nm:
                        inner = layers.declare(cur, None)
                    elif _LAYER_NAME_RE.match(nm):
                        inner = layers.declare(cur, nm)
                    else:
                        # READING: an invalid layer prelude (e.g. "@layer a, b {")
                        # makes the block invalid; it is ignored.
                        continue
                _parse_css_block(body, rules, layers, inner)
            continue
        decls = _parse_decls(body)
        for sel in prelude.split(","):
            ps = _parse_selector(sel)
            if ps:
                rules.append((ps[0], ps[1], len(rules), decls, cur))


def _compound_match(part, frame):
    _, tag, eid, classes = part
    if tag != "*" and frame["tag"] != tag:
        return False
    if eid is not None and frame["id"] != eid:
        return False
    return classes <= frame["classes"]


def _selector_match(parts, frames):
    """frames: ancestors + element, root first. parts: left to right."""
    def match(pi, fi):
        if not _compound_match(parts[pi], frames[fi]):
            return False
        if pi == 0:
            return True
        comb = parts[pi][0]
        if comb == ">":
            return fi - 1 >= 1 and match(pi - 1, fi - 1)
        return any(match(pi - 1, f) for f in range(fi - 1, 0, -1))
    return match(len(parts) - 1, len(frames) - 1)


class _StyleCollector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_style = False
        self.css = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "style":
            self.in_style = True

    def handle_endtag(self, tag):
        if tag.lower() == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.css.append(data)


class _HiddenParser(HTMLParser):
    def __init__(self, rules=()):
        super().__init__(convert_charrefs=True)
        self.rules = list(rules)
        # READING: default page colours are black text on a white background.
        self.stack = [{"tag": "#root", "id": None, "classes": frozenset(), "hidden": False,
                       "color": "#000000", "bg": "#ffffff", "notext": False,
                       "closed_details": False, "summary_seen": False}]
        self.hidden_found = False
        self.texts = []
        self.link_color = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        a = {k.lower(): (v or "") for k, v in attrs}
        parent = self.stack[-1]
        frame = {"tag": tag, "id": a.get("id") or None, "classes": frozenset((a.get("class") or "").split())}
        frames = self.stack + [frame]
        # Cascade (PRD v0.7.4, v0.7.5): key = (!important, inline, layer,
        # specificity, order, position in block); the highest key wins per
        # property. Layer: the rank from _Layers for normal declarations,
        # its negation for !important ones (PRD v0.7.5).
        # READING: the browser default sheet (C-SIG-1.7 v0.7.3) and the
        # presentational attributes (<font color>, <body text>, bgcolor) rank
        # below every author rule, layered or not, the defaults lowest of all.
        hint, ua = (False, False, -10 ** 9, (-1, -1, -1), -1), (False, False, -2 * 10 ** 9, (-1, -1, -1), -1)
        cands = []
        if "hidden" in a or tag in _UA_HIDDEN_TAGS or (tag == "dialog" and "open" not in a):
            cands.append((ua + (0,), "display", "none"))
        # PRD v0.7.3 / TC-SIG-09 v0.7.5: browser default colours count.
        # READING: an <a> with an href is a link and gets the browser's link
        # colour (#0000ee, unvisited) from the default sheet; it does not
        # inherit the parent's colour. <body link="..."> sets that colour as
        # a presentational attribute (HTML Standard rendering section). An
        # <a> without href is not a link and inherits as usual.
        if tag == "a" and "href" in a:
            cands.append((ua + (1,), "color", self.link_color or "#0000ee"))
        if tag == "font" and a.get("color"):
            cands.append((hint + (0,), "color", a["color"].strip().lower()))
        # READING (TC-SIG-09 v0.7.5): <body text="..."> sets the text colour
        # like <font color>.
        if tag == "body" and a.get("text"):
            cands.append((hint + (0,), "color", a["text"].strip().lower()))
        if tag == "body" and a.get("link"):
            self.link_color = a["link"].strip().lower()
        if a.get("bgcolor"):
            cands.append((hint + (1,), "background-color", a["bgcolor"].strip().lower()))
        for parts, spec, order, decls, layer in self.rules:
            if _selector_match(parts, frames):
                for di, (k, v, imp) in enumerate(decls):
                    cands.append(((imp, False, -layer if imp else layer, spec, order, di), k, v))
        for di, (k, v, imp) in enumerate(_parse_decls(a.get("style", ""))):
            cands.append(((imp, True, 0, (0, 0, 0), 0, di), k, v))
        best = {}
        for key, k, v in cands:
            if k not in best or key > best[k][0]:
                best[k] = (key, v)
        st = {k: v for k, (_, v) in best.items()}
        hidden = parent["hidden"]
        # READING: display:none, visibility:hidden, opacity:0 and tiny
        # font-size hide the element and all its descendants.
        if st.get("display", "").startswith("none") or st.get("visibility", "").startswith("hidden"):
            hidden = True
        if "font-size" in st and _font_size_hidden(st["font-size"]):
            hidden = True
        if "opacity" in st and _opacity_hidden(st["opacity"]):
            hidden = True
        color = parent["color"]
        # PRD v0.7.7: CSS-wide keywords. For color: "inherit", "unset" and
        # "currentcolor" take the parent's colour, "initial" is black,
        # "revert" and "revert-layer" give the browser default colour: the
        # link colour for a link (an <a> with href), else the parent's colour.
        # READING: that link colour is the one <body link> set, if any, as for
        # the default sheet above. For background-color: "currentcolor" is the
        # element's text colour; "inherit", "unset", "initial", "revert",
        # "revert-layer" leave the background behind the text unchanged.
        if "color" in st:
            c = _norm_color(st["color"])
            if c == "initial":
                color = "#000000"
            elif c in ("revert", "revert-layer"):
                if tag == "a" and "href" in a:
                    color = _norm_color(self.link_color or "#0000ee")
            elif c not in ("inherit", "unset", "currentcolor"):
                color = c or color
        bg = parent["bg"]
        if "background-color" in st:
            c = _norm_color(st["background-color"])
            if c == "currentcolor":
                c = color
            if c and c not in ("transparent", "inherit", "unset", "initial", "revert", "revert-layer"):
                bg = c
        if parent.get("closed_details"):
            if tag == "summary" and not parent["summary_seen"]:
                parent["summary_seen"] = True
            else:
                hidden = True
        frame.update({"hidden": hidden, "color": color, "bg": bg, "notext": parent["notext"] or tag in _NO_TEXT,
                      "closed_details": tag == "details" and "open" not in a, "summary_seen": False})
        if tag not in _VOID:
            self.stack.append(frame)

    def handle_startendtag(self, tag, attrs):
        pass

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        f = self.stack[-1]
        if f["notext"]:
            return
        if data.strip():
            self.texts.append(data)
            if f["hidden"] or f.get("closed_details") or f["color"] == "transparent" or (f["color"] is not None and f["color"] == f["bg"]):
                self.hidden_found = True

    def handle_comment(self, data):
        # PRD v0.7.1 C-SIG-1.7: HTML comments never count as hidden text,
        # whatever their length (including Outlook conditional comments).
        # C-SIG-1.8: comment text is scanned for injection phrases.
        # READING: the comment is scanned twice, as raw content (markup acts
        # as separators) and with tags inside it removed, so a phrase split by
        # a tag ("do not<b> flag") is still found.
        if data.strip():
            self.texts.append(data)
            self.texts.append(re.sub(r"<[^>]*>", "", data))

    def unknown_decl(self, data):
        # "<![if !mso]>" / "<![endif]>" and similar declarations: no text.
        pass


def _html_scan(html):
    html = normalize_text(html)
    sc = _StyleCollector()
    try:
        sc.feed(html)
        sc.close()
    except Exception:
        pass
    p = _HiddenParser(_parse_css("\n".join(sc.css)))
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    return p.hidden_found, p.texts


def _any_injection(texts) -> bool:
    for t in texts:
        toks = _tokens(normalize_text(t or ""))
        if any(_phrase_spans(toks, p) for p in INJECTION_PHRASES):
            return True
    return False


_SEVERAL = object()


def signals(sig):
    auth, auth_fail, untrusted, dmarc_pass = _auth(sig)
    frm = sig.get("from") or {}
    from_addr = _email_norm(frm.get("address") or "")
    from_name = normalize_text(frm.get("name") or "")
    contacts = sig.get("contacts") or []
    contact_emails = set()
    for c in contacts:
        for e in c.get("emails") or []:
            contact_emails.add(_email_norm(e))

    # 3. display_name_mismatch (PRD v0.7.1): some contact's name has
    # similarity 1 with the display name, and the sender address is not an
    # address of ANY contact whose name has similarity 1.
    similar_addrs, any_similar = set(), False
    for c in contacts:
        num, den = name_similarity_pair(from_name, c.get("name") or "")
        if den > 0 and num == den:
            any_similar = True
            similar_addrs |= {_email_norm(e) for e in c.get("emails") or []}
    dnm = any_similar and from_addr not in similar_addrs

    # 4. lookalike_domain
    contact_domains = {_domain_of(e) for e in contact_emails}
    look = lookalike(_domain_of(from_addr), contact_domains)

    # 5. reply_to_mismatch
    # PRD v0.7.15: several Reply-To headers (RFC 5322 allows one) -> the
    # header cannot be parsed -> the signal is unknown (null).
    # READING: `reply_to` may also be given as a list of header values; a
    # list of one is that value, a list of several is unparseable.
    rt = sig.get("reply_to")
    if isinstance(rt, list):
        rt = rt[0] if len(rt) == 1 else (None if not rt else _SEVERAL)
    if rt is _SEVERAL:
        rtm = None
    else:
        rtm = bool(rt) and bool(_email_norm(rt)) and _email_norm(rt) != from_addr

    # 6. first_time_sender
    prior = {_email_norm(a) for a in sig.get("prior_from_addresses") or []}
    fts = bool(from_addr) and from_addr not in prior and from_addr not in contact_emails

    # 7. hidden_text
    hidden, html_texts = (False, [])
    if sig.get("html"):
        hidden, html_texts = _html_scan(sig["html"])

    # 8. injection_markers
    # READING: besides the given texts, the text of the HTML body (all text
    # nodes and comments, hidden or not) is scanned too.
    inj = _any_injection(list(sig.get("texts") or []) + html_texts)

    return {
        "auth": auth, "auth_fail": auth_fail, "untrusted_auth_header": untrusted,
        "display_name_mismatch": dnm, "lookalike_domain": look, "reply_to_mismatch": rtm,
        "first_time_sender": fts, "hidden_text": hidden, "injection_markers": inj,
        "dmarc_pass": dmarc_pass,
    }


# ---------------------------------------------------------------------------
# C-SIG-3 authenticated sender (with C-LNK-1)
# ---------------------------------------------------------------------------


def authenticated_sender(inp):
    # READING: the input may be the signals input itself or wrap it as
    # {"signals_input": {...}}.
    sig = inp.get("signals_input", inp)
    from_addr = _email_norm((sig.get("from") or {}).get("address") or "")
    matches = []
    for c in sig.get("contacts") or []:
        if from_addr and from_addr in {_email_norm(e) for e in c.get("emails") or []}:
            if c.get("contact_id") not in matches:
                matches.append(c.get("contact_id"))
    auth, auth_fail, _, dmarc_pass = _auth(sig)
    ok = len(matches) == 1 and dmarc_pass and not auth_fail and auth != "unknown"
    # READING: contact_id is returned only when the sender is authenticated.
    return {"authenticated": ok, "contact_id": matches[0] if ok else None}


# ---------------------------------------------------------------------------
# C-AUD-1 hash chain (RFC 8785 JCS)
# ---------------------------------------------------------------------------

_MAX_SAFE = 2 ** 53 - 1


def _jcs_string(s: str) -> str:
    out = ['"']
    for c in s:
        o = ord(c)
        if c == '"':
            out.append('\\"')
        elif c == "\\":
            out.append("\\\\")
        elif c == "\b":
            out.append("\\b")
        elif c == "\f":
            out.append("\\f")
        elif c == "\n":
            out.append("\\n")
        elif c == "\r":
            out.append("\\r")
        elif c == "\t":
            out.append("\\t")
        elif o < 0x20:
            out.append("\\u%04x" % o)
        elif 0xD800 <= o <= 0xDFFF:
            raise ValueError("lone surrogate in string")
        else:
            out.append(c)
    out.append('"')
    return "".join(out)


def _utf16_key(s: str):
    return s.encode("utf-16-be")


def jcs(v) -> str:
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, int):
        # READING: integers outside the IEEE-754 safe range are rejected
        # (JCS serialises numbers as ECMAScript doubles).
        if abs(v) > _MAX_SAFE:
            raise ValueError("integer outside safe range")
        return str(v)
    if isinstance(v, float):
        if v.is_integer() and abs(v) <= _MAX_SAFE:
            return str(int(v))
        raise ValueError("non-integer numbers are not used in audit records")
    if isinstance(v, str):
        return _jcs_string(v)
    if isinstance(v, list):
        return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v.keys(), key=_utf16_key)
        return "{" + ",".join(_jcs_string(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise ValueError("unsupported JSON type: %r" % type(v))


def audit_hash_of(record: dict) -> str:
    body = {k: v for k, v in record.items() if k != "hash"}
    return hashlib.sha256(jcs(body).encode("utf-8")).hexdigest()


def audit_hash(inp):
    return {"hash": audit_hash_of(inp["record"])}


def verify_chain(inp):
    prev = "0" * 64
    for i, r in enumerate(inp["records"]):
        seq = r.get("seq")
        # READING: the first failing record is reported by its own seq value;
        # checks are seq continuity, prev_hash link, then the recomputed hash.
        if not isinstance(seq, int) or isinstance(seq, bool) or seq != i + 1:
            return {"ok": False, "bad_seq": seq}
        if r.get("prev_hash") != prev:
            return {"ok": False, "bad_seq": seq}
        try:
            h = audit_hash_of(r)
        except ValueError:
            return {"ok": False, "bad_seq": seq}
        if r.get("hash") != h:
            return {"ok": False, "bad_seq": seq}
        prev = h
    return {"ok": True, "bad_seq": None}


# ---------------------------------------------------------------------------
# E3: calendar and time limits (C-RTE-1, C-RTE-2, R-RTE-02)
# ---------------------------------------------------------------------------
# Written from PRD v0.7.12 / test plan v0.7.11 (BRIEF part 2).

import datetime as _dt
from zoneinfo import ZoneInfo

LEVELS = ("low", "medium", "high")
_LEVEL_RANK = {"low": 0, "medium": 1, "high": 2}

# PRD §3.1 default class table (order, risk floor, default queue).
DEFAULT_CLASSES = [
    ("payment_query", "medium", "ops"), ("payment_evidence", "medium", "ops"),
    ("unreferenced_payment", "medium", "ops"), ("kyc_documents", "high", "compliance"),
    ("withdrawal", "high", "ops"), ("commitment_change", "medium", "ops"),
    ("fee_or_terms_change", "high", "deal_ops"), ("closing_confirmation", "medium", "deal_ops"),
    ("legal_documents", "high", "legal"), ("bank_details", "high", "compliance"),
    ("identity_change", "high", "compliance"), ("tax_certificates", "medium", "legal"),
    ("exit_distribution", "medium", "deal_ops"), ("bank_letter_request", "low", "ops"),
    ("account_access", "medium", "ops"), ("complaint", "medium", "ops_lead"),
    ("other_known", "high", "ops_lead"), ("unclassified", "medium", "ops"),
]


def _date(s):
    """ISO YYYY-MM-DD -> date, or None when not a valid calendar date."""
    if not isinstance(s, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", s):
        return None
    try:
        return _dt.date.fromisoformat(s)
    except ValueError:
        return None


def _utc(s):
    """ISO 8601 date-time -> aware UTC datetime. A value without an offset is UTC."""
    t = _dt.datetime.fromisoformat(s.strip().replace("Z", "+00:00").replace("z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=_dt.timezone.utc)
    return t.astimezone(_dt.timezone.utc)


def _iso_utc(t):
    t = t.astimezone(_dt.timezone.utc)
    if t.microsecond:
        return t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class _Cal:
    def __init__(self, cal):
        cal = cal or {}
        self.tz = ZoneInfo(cal.get("timezone") or "Europe/London")
        sh, sm = (int(x) for x in (cal.get("start") or "09:00").split(":"))
        eh, em = (int(x) for x in (cal.get("end") or "18:00").split(":"))
        self.start = _dt.time(sh, sm)
        self.end = _dt.time(eh, em)
        self.holidays = {_dt.date.fromisoformat(h) for h in (cal.get("holidays") or [])}
        self.day_hours = ((eh * 60 + em) - (sh * 60 + sm)) / 60.0

    def working(self, d):
        # C-RTE-1: Monday to Friday, minus the configured holidays.
        return d.weekday() < 5 and d not in self.holidays

    def local_date(self, value):
        # READING: a plain date is taken as it is; a date-time is converted
        # to its date in the deployment time zone (C-RSK-2a says so for the
        # receive day; C-DRF-4 is read the same way).
        if isinstance(value, _dt.date) and not isinstance(value, _dt.datetime):
            return value
        if isinstance(value, str) and _date(value):
            return _date(value)
        t = value if isinstance(value, _dt.datetime) else _utc(value)
        return t.astimezone(self.tz).date()

    def at(self, d, tm):
        """Local wall-clock d+tm -> aware UTC datetime (fold=0)."""
        return _dt.datetime.combine(d, tm).replace(tzinfo=self.tz).astimezone(_dt.timezone.utc)


def working_days_between(cal: _Cal, a, b) -> int:
    # Working days d with a < d <= b (C-DRF-4 / C-RSK-2a count).
    # READING: when b <= a the count is 0 (callers check the order first).
    n = 0
    d = a + _dt.timedelta(days=1)
    while d <= b:
        if cal.working(d):
            n += 1
        d += _dt.timedelta(days=1)
    return n


def working_days_after(inp):
    cal = _Cal(inp.get("calendar"))
    a = cal.local_date(inp["from"])
    b = cal.local_date(inp["to"])
    return {"days": working_days_between(cal, a, b)}


def _add_working_hours(cal: _Cal, start, hours):
    # READING: working time is counted in local wall-clock time inside the
    # working period of each working day (so 09:00-18:00 is 9 working hours
    # on a clock-change day too). A start outside the working period moves to
    # the next period start; a limit that ends exactly at the end of a period
    # is that end time, not the next morning.
    remaining = _dt.timedelta(seconds=round(hours * 3600 * 1000) / 1000)
    loc = start.astimezone(cal.tz)
    d = loc.date()
    cur = loc.replace(tzinfo=None)
    while True:
        if cal.working(d):
            ps = _dt.datetime.combine(d, cal.start)
            pe = _dt.datetime.combine(d, cal.end)
            s = max(cur, ps)
            if s < pe:
                avail = pe - s
                if remaining <= avail:
                    return (s + remaining).replace(tzinfo=cal.tz).astimezone(_dt.timezone.utc)
                remaining -= avail
        d += _dt.timedelta(days=1)
        cur = _dt.datetime.combine(d, _dt.time(0, 0))


def _working_time_between(cal: _Cal, a, b):
    """Working time (timedelta) between aware datetimes a <= b."""
    if b <= a:
        return _dt.timedelta(0)
    la = a.astimezone(cal.tz).replace(tzinfo=None)
    lb = b.astimezone(cal.tz).replace(tzinfo=None)
    total = _dt.timedelta(0)
    d = la.date()
    while d <= lb.date():
        if cal.working(d):
            s = max(la, _dt.datetime.combine(d, cal.start))
            e = min(lb, _dt.datetime.combine(d, cal.end))
            if e > s:
                total += e - s
        d += _dt.timedelta(days=1)
    return total


def due_at(inp):
    cal = _Cal(inp.get("calendar"))
    t = _add_working_hours(cal, _utc(inp["received_at"]), float(inp["working_hours"]))
    return {"due_at": _iso_utc(t)}


def follow_up_at(inp):
    # C-RTE-2: 10 working days (configurable) x the working-day length, from
    # the receive time; only for the three payment classes, while the Case is
    # open and the reminder is enabled.
    cal = _Cal(inp.get("calendar"))
    days = inp.get("days", 10)
    payment = {"payment_query", "payment_evidence", "unreferenced_payment"}
    if not inp.get("enabled", True) or inp.get("closed", False) or days is None:
        return {"follow_up_at": None}
    if "adopted" in inp and not (set(inp["adopted"]) & payment):
        return {"follow_up_at": None}
    t = _add_working_hours(cal, _utc(inp["received_at"]), days * cal.day_hours)
    return {"follow_up_at": _iso_utc(t)}


def due_state(inp):
    # R-RTE-02: reminder when the remaining share of the limit is at most
    # remind_share (default 25 %), red when over.
    # READING: both shares are measured in working time (C-RTE-1); "over"
    # means now is later than due_at (at due_at exactly it is due_soon).
    cal = _Cal(inp.get("calendar"))
    rec, due, now = _utc(inp["received_at"]), _utc(inp["due_at"]), _utc(inp["now"])
    share = inp.get("remind_share", 0.25)
    if now > due:
        return {"state": "overdue"}
    total = _working_time_between(cal, rec, due)
    left = _working_time_between(cal, now, due)
    if total.total_seconds() <= 0 or left.total_seconds() <= share * total.total_seconds():
        return {"state": "due_soon"}
    return {"state": "ok"}


def queue(inp):
    # R-RTE-01: the queue of the adopted class with the highest risk floor;
    # equal floors -> the class earlier in the §3.1 table.
    classes = inp.get("classes") or [{"id": c, "risk_floor": f} for c, f, _ in DEFAULT_CLASSES]
    queues = inp.get("queues") or {c: q for c, _, q in DEFAULT_CLASSES}
    adopted = list(inp.get("adopted") or []) or ["unclassified"]
    order = [c["id"] for c in classes]
    floor = {c["id"]: c["risk_floor"] for c in classes}
    best = None
    for cid in order:
        if cid in adopted and (best is None or _LEVEL_RANK[floor[cid]] > _LEVEL_RANK[floor[best]]):
            best = cid
    return {"class": best, "queue": queues.get(best)}


# ---------------------------------------------------------------------------
# E3: risk (C-RSK-1, C-RSK-2, C-RSK-2a, C-RSK-3)
# ---------------------------------------------------------------------------

PRESSURE_PHRASES = ["urgent", "urgently", "immediately", "today", "asap", "confidential",
                    "do not tell", "don't tell", "keep this between us", "before close"]
_PRESSURE_CLASSES = {"payment_query", "payment_evidence", "unreferenced_payment", "bank_details",
                     "withdrawal", "exit_distribution"}
_CLOSING_CLASSES = {"bank_details", "payment_query", "payment_evidence", "unreferenced_payment"}

RSK2_SIGNALS = ["display_name_mismatch", "lookalike_domain", "hidden_text", "injection_markers",
                "message_id_collision"]
RSK2A_SIGNALS = ["auth_fail", "untrusted_auth_header", "reply_to_mismatch"]


def _class_table(classes):
    if not classes:
        classes = [{"id": c, "risk_floor": f} for c, f, _ in DEFAULT_CLASSES]
    order = [c["id"] for c in classes]
    floor = {c["id"]: c["risk_floor"] for c in classes}
    return order, floor


def _adopted(adopted):
    # C-CLS-2: no adopted label -> unclassified is adopted.
    a = [c for c in (adopted or [])]
    return a if a else ["unclassified"]


def _amount_set(xs):
    return {(int(a["minor"]), str(a["currency"]).upper()) for a in (xs or []) if a and a.get("minor") is not None}


def _sig(signals, name):
    # READING: an unknown signal (null) counts as not hit.
    return bool((signals or {}).get(name))


def risk(inp):
    order, floor = _class_table(inp.get("classes"))
    adopted = _adopted(inp.get("adopted"))
    labels = set(adopted) | set(inp.get("low") or [])  # C-RSK-1 / C-CLS-2 label set
    for c in labels:
        if c not in floor:
            raise ValueError("unknown class: %s" % c)
    base = max((_LEVEL_RANK[floor[c]] for c in labels), default=0)
    sig = inp.get("signals") or {}
    clauses = []
    for s in RSK2_SIGNALS:
        if _sig(sig, s):
            clauses.append("C-RSK-2:" + s)
    if _sig(sig, "first_time_sender") and inp.get("account_present"):
        clauses.append("C-RSK-2:first_time_sender_account")
    if inp.get("uetr_candidates_invalid"):
        clauses.append("C-RSK-2:uetr_candidate_invalid")
    A = _amount_set(inp.get("amounts_attachment"))
    B = _amount_set(inp.get("amounts_body"))
    # READING: amounts are compared as (minor units, currency) pairs.
    if A and B and not (A & B):
        clauses.append("C-RSK-2:amount_mismatch")
    if inp.get("attachment_blocked_or_over_limit"):
        clauses.append("C-RSK-2:attachment_blocked_or_over_limit")
    high = bool(clauses)
    steps = 0
    for s in RSK2A_SIGNALS:
        if _sig(sig, s):
            clauses.append("C-RSK-2a:" + s)
            steps += 1
    if inp.get("pressure_text") is not None:
        pressure = bool(wordlist_match({"text": inp["pressure_text"], "phrases": PRESSURE_PHRASES})["matched"])
    else:
        pressure = bool(inp.get("pressure_words"))
    if pressure and labels & _PRESSURE_CLASSES:
        clauses.append("C-RSK-2a:pressure")
        steps += 1
    pcd = inp.get("planned_close_date")
    if pcd and labels & _CLOSING_CLASSES:
        cal = _Cal(inp.get("calendar"))
        close = _date(pcd)
        recv = cal.local_date(inp["received_at"])
        if close is not None and close >= recv and working_days_between(cal, recv, close) <= 3:
            clauses.append("C-RSK-2a:closing")
            steps += 1
    computed_rank = 2 if high else min(2, base + steps)
    computed = LEVELS[computed_rank]

    adj = inp.get("adjustment")
    # READING: the "reasons present now" are the label classes whose floor is
    # above the adjustment level L (with no adjustment: every label class,
    # i.e. the filter for a level below low), in class-table order, then the
    # clause IDs hit, in the brief's order. The caller stores them as R0 when
    # an adjustment is made.
    thr = _LEVEL_RANK[adj["level"]] if adj else -1
    reason_classes = [c for c in order if c in labels and _LEVEL_RANK[floor[c]] > thr]
    clause_order = ["C-RSK-2:" + s for s in RSK2_SIGNALS] + [
        "C-RSK-2:first_time_sender_account", "C-RSK-2:uetr_candidate_invalid", "C-RSK-2:amount_mismatch",
        "C-RSK-2:attachment_blocked_or_over_limit"] + ["C-RSK-2a:" + s for s in RSK2A_SIGNALS] + [
        "C-RSK-2a:pressure", "C-RSK-2a:closing"]
    reasons = reason_classes + [c for c in clause_order if c in clauses]

    final, void = computed, False
    if adj:
        L = _LEVEL_RANK[adj["level"]]
        C0 = _LEVEL_RANK[adj["computed_at_set"]]
        if L == C0:
            # ③ L equal to the computed risk at the time -> no adjustment.
            final = computed
        elif L > C0:
            # ④ raise: max(computed, L), always in force.
            final = LEVELS[max(computed_rank, L)]
        else:
            # ⑤ lower: min(computed, L) unless computed > C0 or a reason
            # outside R0 appears -> void for good, final = computed.
            R0 = set(adj.get("reasons") or [])
            new = [r for r in reasons if r not in R0]
            if computed_rank > C0 or new:
                void = True
                final = computed
            else:
                final = LEVELS[min(computed_rank, L)]
    return {"computed": computed, "reasons": reasons, "final": final, "adjustment_void": void}


def risk_adjust(inp):
    # C-RSK-3 ② permission and ③ cancel, for a new manual adjustment.
    # Input {role: "reviewer"|"approver", reason: str|null, level, current_final, computed_now}.
    L = _LEVEL_RANK[inp["level"]]
    lower = L < _LEVEL_RANK[inp["current_final"]]
    # READING: a reason is "filled in" when it has a non-whitespace character.
    if lower and (inp.get("role") != "approver" or not (inp.get("reason") or "").strip()):
        return {"allowed": False, "cancels": False}
    return {"allowed": True, "cancels": inp["level"] == inp["computed_now"]}


# ---------------------------------------------------------------------------
# E3: disclosure, ledger, templates (C-LNK-5, C-DRF-2 to C-DRF-6)
# ---------------------------------------------------------------------------

DISCLOSES_RECORD = {"payment_received", "payment_wait", "payment_need_evidence", "exit_info",
                    "withdrawal_ack", "commitment_change_ack"}
ASSERTS_RECEIPT = {"payment_received"}
DEFAULT_TEMPLATE = {
    "unreferenced_payment": "unreferenced_ack", "kyc_documents": "kyc_received",
    "withdrawal": "withdrawal_ack", "commitment_change": "commitment_change_ack",
    "fee_or_terms_change": "safe_ack", "closing_confirmation": "closing_ack",
    "legal_documents": "legal_ack", "bank_details": "safe_ack", "identity_change": "safe_ack",
    "tax_certificates": "tax_cert_info", "exit_distribution": "exit_info",
    "bank_letter_request": "bank_letter_info", "account_access": "account_access_info",
    "complaint": "complaint_ack", "other_known": "safe_ack",
}


def may_disclose(inp):
    key = inp.get("commitment_key")
    ok = bool(inp.get("authenticated_sender")) and key is not None and (
        key in (inp.get("contact_investor_ids") or []) or key in (inp.get("contact_authorised_for") or []))
    return {"allowed": ok}


def ledger_state(inp):
    rows = inp.get("ledger")
    # PRD v0.7.24 C-DRF-6: an empty ledger left by an explicit clear
    # (R-DIR-04 `clear=yes`) counts as no ledger.
    # READING: R-E6-11. TC-DIR-09 preserves pre-D9 empty ledgers without
    # a clear marker. An empty list alone therefore still means a ledger
    # exists. Optional ledger_cleared=True supplies the explicit-clear
    # provenance; exports may instead project a cleared ledger to null.
    if rows is None or (not rows and inp.get("ledger_cleared") is True):
        return {"state": "unknown"}
    inv = inp.get("investor_id")
    key = inp.get("commitment_key")
    ccy = str(inp.get("deal_currency") or "").upper()
    got = 0
    for r in rows:
        # READING: a ledger row's investor_id may be the bare ID (Toolkit
        # export) or the commitment key; either form names the commitment.
        # Currency codes are compared in upper case. C-DIR-3 (v0.7.14): an
        # empty (or missing / blank) currency cell is the deal currency.
        rc = str(r.get("currency") or "").strip().upper() or ccy
        if r.get("status") in ("auto", "confirmed") and r.get("investor_id") is not None \
                and r.get("investor_id") in (inv, key) and rc == ccy:
            got += int(r["amount_minor"])
    return {"state": "received" if got >= int(inp["cash_due_minor"]) else "not_received"}


def _single(v):
    """Single-value projection (§5.5a): multiple / void / missing -> None."""
    if isinstance(v, dict):
        return None
    return v


def _is_multiple(v):
    return isinstance(v, dict) and "multiple" in v


def primary_class(classes, adopted):
    order, floor = _class_table(classes)
    adopted = _adopted(adopted)
    # READING: unclassified is only a candidate for the primary class when it
    # is the only adopted label (C-CLS-2 adds it only then); it has no
    # default template.
    cands = [c for c in adopted if c != "unclassified"] or adopted
    best = None
    for c in order:
        if c in cands and (best is None or _LEVEL_RANK[floor[c]] > _LEVEL_RANK[floor[best]]):
            best = c
    return best


def _payment_date(primary, evidence_value_dates, value_date, payment_date):
    """C-DRF-4 payment-date source -> (date|None, known: bool)."""
    ev = sorted({d for d in (evidence_value_dates or []) if d})
    if ev:
        if len(ev) > 1:
            return None, False
        return ev[0], True
    # READING: without evidence the primary class's field is used
    # (payment_evidence -> value_date, payment_query -> payment_date); the
    # other field is used when the primary's is empty. Both present and
    # different -> unknown. A field with several values ("multiple", §6
    # rule input) makes the date unknown; a void field counts as empty
    # (single-value projection).
    if _is_multiple(value_date) or _is_multiple(payment_date):
        return None, False
    vd, pd = _single(value_date), _single(payment_date)
    if vd and pd and vd != pd:
        return None, False
    first, second = (vd, pd) if primary == "payment_evidence" else (pd, vd)
    d = first or second
    if not d:
        return None, False
    return d, True


def _payment_template(inp, primary):
    if not inp.get("linked_commitment"):
        return "payment_need_reference"
    st = inp.get("ledger_state")
    if st == "received":
        return "payment_received"
    if st != "not_received":
        return "payment_need_evidence"
    d, known = _payment_date(primary, inp.get("evidence_value_dates"), inp.get("value_date"), inp.get("payment_date"))
    if not known:
        return "payment_need_evidence"
    cal = _Cal(inp.get("calendar"))
    pd = _date(d)
    recv = cal.local_date(inp["received_at"])
    # A payment date later than the receive day (deployment time zone) is
    # invalid; so is a value that is not a calendar date.
    if pd is None or pd > recv:
        return "payment_need_evidence"
    return "payment_wait" if working_days_between(cal, pd, recv) < 5 else "payment_need_evidence"


def template(inp):
    adopted = _adopted(inp.get("adopted"))
    primary = primary_class(inp.get("classes"), adopted)
    if primary == "unclassified":
        primary_out = None
    else:
        primary_out = primary
    if "bank_details" in adopted or "identity_change" in adopted:          # ①
        return {"template": "safe_ack", "primary": primary_out}
    if inp.get("risk") == "high":                                           # ②
        return {"template": "safe_ack", "primary": primary_out}
    if set(adopted) == {"unclassified"}:                                    # ③
        return {"template": None, "primary": None}
    if primary in ("payment_query", "payment_evidence"):                    # ④
        t = _payment_template(inp, primary)
    else:
        t = DEFAULT_TEMPLATE[primary]
    # PRD v0.7.15 (C-DRF-7): a template marked asserts_receipt counts as
    # discloses_record, and is chosen only when the ledger state is
    # "received" (with the C-DRF-5 templates the C-DRF-4 path already
    # guarantees this; READING: otherwise it falls back to safe_ack).
    if t in ASSERTS_RECEIPT and inp.get("ledger_state") != "received":
        t = "safe_ack"
    if t in (DISCLOSES_RECORD | ASSERTS_RECEIPT) and not inp.get("may_disclose"):  # ⑤
        t = "safe_ack"
    return {"template": t, "primary": primary_out}


INTERNAL_TERMS = ["fraud", "fraudulent", "suspicious", "suspect", "scam", "risk level", "high risk",
                  "flagged", "flag", "verification task", "cooling-off", "cooling off", "two-person",
                  "signal", "lookalike", "spoof", "spoofed", "injection", "money laundering", "sar",
                  "tipping off"]


def reply_check(inp):
    terms = INTERNAL_TERMS + [t for t in (inp.get("extra_internal_terms") or []) if t not in INTERNAL_TERMS]
    hits = wordlist_match({"text": inp["text"], "phrases": terms})["matched"]
    return {"ok": not hits, "hits": hits}


_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z0-9_]+)\}")


def _sentences(line):
    # READING: a sentence ends after ".", "!" or "?" followed by whitespace or
    # the end of the line; a line break always ends a sentence. Each piece
    # keeps the whitespace that follows it.
    out, i = [], 0
    for m in re.finditer(r"[.!?]+(?:\s+|$)", line):
        out.append(line[i:m.end()])
        i = m.end()
    if i < len(line):
        out.append(line[i:])
    return out


def fill(inp):
    values = inp.get("values") or {}

    def has(name):
        # READING: null, a missing key or an empty / whitespace-only string
        # is "no value".
        v = values.get(name)
        return isinstance(v, str) and v.strip() != ""

    removed = 0
    out_lines = []
    for line in re.split(r"(\r\n|\n|\r)", inp["template_text"]):
        if line in ("\r\n", "\n", "\r"):
            out_lines.append(line)
            continue
        kept = []
        had = False
        for s in _sentences(line):
            if any(not has(n) for n in _PLACEHOLDER_RE.findall(s)):
                removed += 1
                had = True
                continue
            kept.append(s)
        new = "".join(kept).rstrip() if had else line
        if had and new.strip() == "":
            out_lines.append(None)  # line removed with its line break
        else:
            out_lines.append(new)
    # READING: a line whose every sentence was removed is removed together
    # with the line break after it (or before it, for the last line).
    text_parts = []
    i = 0
    while i < len(out_lines):
        x = out_lines[i]
        if x is None:
            if i + 1 < len(out_lines) and out_lines[i + 1] in ("\r\n", "\n", "\r"):
                i += 2
                continue
            if text_parts and text_parts[-1] in ("\r\n", "\n", "\r"):
                text_parts.pop()
            i += 1
            continue
        text_parts.append(x)
        i += 1
    text = "".join(text_parts)
    # Values are inserted once, literally (a value is never read as a placeholder).
    text = _PLACEHOLDER_RE.sub(lambda m: values[m.group(1)], text)
    return {"text": text, "removed_sentences": removed}


def recipient(inp):
    prop = _email_norm(inp.get("proposed"))
    if not prop:
        return {"allowed": False}
    if inp["kind"] == "notify_old_contact":
        d = _email_norm(inp.get("directory_email"))
        return {"allowed": bool(d) and prop == d}
    if inp["kind"] != "case_reply":
        raise ValueError("unknown kind: %s" % inp["kind"])
    frm = inp.get("from")
    if isinstance(frm, dict):
        frm = frm.get("address")
    allowed = {_email_norm(frm)}
    # PRD v0.7.15 (C-SIG-1.5): several Reply-To headers or an unknown
    # reply_to_mismatch (null) -> reply only to From.
    rt = inp.get("reply_to")
    if isinstance(rt, list):
        rt = rt[0] if len(rt) == 1 else None
    rt = _email_norm(rt)
    if rt and inp.get("reply_to_mismatch") is False:
        allowed.add(rt)
    allowed.discard("")
    return {"allowed": prop in allowed}


# ---------------------------------------------------------------------------
# E3: suggested actions (C-OUT-3)
# ---------------------------------------------------------------------------

_VERIFY = "Verify the request by calling the phone number on file"
_CONSENT_OK = {"investor_cc", "forwarded_written_consent", "attached_document", "investor_self"}


def _t(s, **kv):
    # READING: a placeholder whose value is empty is rendered as an empty
    # string (the details templates have no sentence-removal rule).
    return re.sub(r"\{([a-z_]+)\}", lambda m: "" if kv.get(m.group(1)) is None else str(kv[m.group(1)]), s)


def actions(inp):
    adopted = set(_adopted(inp.get("adopted")))
    f = inp.get("fields") or {}
    consent = _single(f.get("consent_evidence"))
    change_type = _single(f.get("change_type"))
    confirms = _single(f.get("confirms"))
    out = []
    if "bank_details" in adopted:
        out.append({"action": "start_bank_details_verification", "details": _VERIFY})
    if "identity_change" in adopted:
        out.append({"action": "start_identity_verification", "details": _VERIFY})
    if "withdrawal" in adopted:
        if consent in _CONSENT_OK:
            out.append({"action": "mark_withdrawn", "details": _t(
                "Mark {investor_name} as withdrawn in Deal Ops Toolkit (consent: {consent_evidence})",
                investor_name=inp.get("investor_name"), consent_evidence=consent)})
        else:
            out.append({"action": "request_withdrawal_consent",
                        "details": "Ask for the investor's written consent before marking the withdrawal"})
    if "fee_or_terms_change" in adopted:
        if change_type == "fee_payer":
            out.append({"action": "review_fee_payer_change", "details": _t(
                "Review the fee payer change and the consent evidence ({consent_evidence})", consent_evidence=consent)})
        else:
            out.append({"action": "review_terms_change", "details": _t(
                "Review the requested change to the deal terms and the consent evidence ({consent_evidence})",
                consent_evidence=consent)})
    pay = bool(adopted & {"payment_query", "payment_evidence"})
    if pay and inp.get("linked_commitment"):
        out.append({"action": "check_payment_in_ledger", "details": _t(
            "Check {investor_name}'s payment in the ledger ({reference})",
            investor_name=inp.get("investor_name"), reference=inp.get("reference"))})
    if pay and inp.get("template") == "payment_need_evidence":
        out.append({"action": "request_payment_evidence", "details": "Ask for the payment confirmation with UETR"})
    if "kyc_documents" in adopted:
        out.append({"action": "forward_kyc_documents", "details": "Forward the documents to the KYC process"})
    if adopted & {"legal_documents", "tax_certificates"}:
        out.append({"action": "forward_to_legal", "details": "Forward to the legal team"})
    # Appendix A closing.lead_confirmed condition.
    if "closing_confirmation" in adopted and confirms == "yes" and inp.get("confirms_confirmed_by_person") \
            and inp.get("authenticated_sender") and inp.get("sender_is_lead_of_deal"):
        out.append({"action": "record_lead_confirmation",
                    "details": _t("Record the lead's confirmation for {deal}", deal=inp.get("deal"))})
    if not out:
        out.append({"action": "none", "details": None})
    return {"actions": out}


def lead_confirmed(inp):
    # Appendix A closing.lead_confirmed: same condition as the action above.
    a = actions(dict(inp, adopted=inp.get("adopted")))["actions"]
    return {"emit": any(x["action"] == "record_lead_confirmation" for x in a)}


# ---------------------------------------------------------------------------
# E4: C-RED-0 «possibly KYC» attachments (with C-ING-2 ⑤ for unparsed XML)
# ---------------------------------------------------------------------------

# PRD C-RED-0 ① word list (v0.7.8). The six Chinese words are matched as
# substrings (v0.7.11); every other word / phrase by I-05 whole words.
KYC_WORDS = [
    "passport", "driving", "licence", "license", "utility", "bank statement", "proof of address",
    "poa", "id card", "identity", "certificate of incorporation", "trust deed", "register of members",
    "ubo", "structure chart",
    # de
    "reisepass", "personalausweis", "führerschein", "kontoauszug",
    # fr
    "passeport", "carte d'identité", "permis de conduire", "justificatif de domicile", "relevé bancaire",
    # es
    "pasaporte", "dni", "documento de identidad", "permiso de conducir", "extracto bancario",
]
KYC_WORDS_ZH = ["护照", "身份证", "驾驶证", "银行对账单", "住址证明", "营业执照"]
KYC_BIRTH_WORDS = ["date of birth", "place of birth", "nationality"]

# READING (R-E4-02): «中日韩文字（汉字、假名、谚文）» = these code-point ranges
# (after I-04): CJK radicals and ideographs incl. extensions and compatibility
# ideographs, the ideographic iteration / number marks, Hiragana, Katakana
# (incl. phonetic extensions and half-width forms), Hangul Jamo, compatibility
# Jamo, extended Jamo and syllables. In C-RED-0 they are word separators.
_CJK_RANGES = (
    (0x1100, 0x11FF), (0x2E80, 0x2FDF), (0x3005, 0x3007), (0x3021, 0x3029), (0x3031, 0x3035),
    (0x3038, 0x303C), (0x3040, 0x30FF), (0x3130, 0x318F), (0x31F0, 0x31FF), (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF), (0xA960, 0xA97F), (0xAC00, 0xD7FF), (0xF900, 0xFAFF), (0xFF66, 0xFFDC),
    (0x20000, 0x323AF),
)


def _is_cjk(c: str) -> bool:
    o = ord(c)
    return any(a <= o <= b for a, b in _CJK_RANGES)


def _kyc_word_hits(text: str, words):
    """C-RED-0 ①/② words in one text: I-04, CJK as separators, I-05 whole words; Chinese words as substrings."""
    t = normalize_text(text or "")
    # C-RED-0 «转小写»: I-05 already ignores case (casefold), so lower-casing changes nothing more.
    sep = "".join(" " if _is_cjk(c) else c for c in t)
    toks = _tokens(sep)
    hits = {w for w in words if _phrase_spans(toks, w)}
    hits |= {w for w in KYC_WORDS_ZH if w in t}
    return hits


# PRD v0.7.19 C-RED-0 ②: an MRZ line starts with `P`, characters 2-5 are
# all upper-case letters or `<`, the line contains `<<`; leading whitespace
# is allowed.
# READING (R-E4-03): a «line» is split at every line break Python's
# str.splitlines() knows (LF, CR, CRLF, VT, FF, FS/GS/RS, NEL, U+2028,
# U+2029). «行首可有空白» = any run of whitespace characters (str.isspace)
# before the `P`; characters 2-5 are counted from that `P`. «大写字母» =
# ASCII A-Z after I-04 (full-width letters and `＜` are folded by NFKC). The
# `<<` may be anywhere in the line, including inside characters 2-5
# (`P<D<<…`). A line shorter than 5 characters after the whitespace is not
# an MRZ.
_MRZ_HEAD_RE = re.compile(r"P[A-Z<]{4}")


def _is_mrz_line(line: str) -> bool:
    return bool(_MRZ_HEAD_RE.match(line.lstrip())) and "<<" in line


def _has_mrz(text: str) -> bool:
    return any(_is_mrz_line(line) for line in normalize_text(text or "").splitlines())


_IMAGE_KINDS = {"image", "png", "jpeg", "jpg", "gif", "bmp", "tiff", "tif", "webp", "heic", "heif", "svg", "ico"}
_GENERIC_KINDS = {"", "other", "unknown", "application/octet-stream", "binary"}
_MIME_KIND = {
    "application/pdf": "pdf", "message/rfc822": "eml", "text/plain": "txt", "text/csv": "csv",
    "application/xml": "xml", "text/xml": "xml",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}


def _att_type(kind, filename) -> str:
    """Attachment type from `kind` (a type token or a MIME type), else from the file-name extension."""
    # READING (R-E4-04): the test plan does not list `kind` values. A MIME
    # type (`image/png`, `application/pdf` …) or a short token (`pdf`,
    # `image`, `png`, `eml` …) are both accepted, case-insensitive. Only when
    # `kind` is missing or generic (`other`, `application/octet-stream`) does
    # the file-name extension decide.
    k = (kind or "").strip().lower()
    if k.startswith("image/"):
        return "image"
    if k in _MIME_KIND:
        return _MIME_KIND[k]
    if k.endswith("+xml"):
        return "xml"
    if k in _IMAGE_KINDS:
        return "image"
    if k not in _GENERIC_KINDS:
        return k
    name = normalize_text(filename or "").lower()
    ext = name.rsplit(".", 1)[1] if "." in name else ""
    if ext in _IMAGE_KINDS:
        return "image"
    return ext or "other"


_UNCHECKABLE = {"unsupported", "over_limit", "failed", "timeout", "blocked", "encrypted", "too_deep"}
KYC_MAX_DEPTH = 3


def _kyc_node(att, depth, clauses, texts):
    """Collect clauses ①③④⑤ of one node and its descendants, and every text of the subtree."""
    typ = _att_type(att.get("kind"), att.get("filename"))
    status = att.get("parse_status")
    if _kyc_word_hits(att.get("filename") or "", KYC_WORDS):
        clauses.add("1")
    if typ == "image":
        clauses.add("3")
    if typ == "pdf" and status == "ok":
        pages, no_text = att.get("pdf_pages"), att.get("pdf_pages_without_text")
        # READING (R-E4-05): ④ holds for a parsed PDF when any page has no text
        # layer, when the page counts are missing or zero, or when the
        # extracted text is empty / whitespace only (no extractable text).
        if (not isinstance(pages, int) or not isinstance(no_text, int) or pages <= 0 or no_text > 0
                or not (att.get("text") or "").strip()):
            clauses.add("4")
    # READING (R-E4-06): ⑤ «无法完成检查» = every parse_status except `ok`:
    # failed, timeout, over_limit, encrypted, too_deep, unsupported (unknown
    # type, incl. XML that is not a recognised pacs.008, C-ING-2) and also
    # `blocked` (virus scan blocked it, so it was never checked). An image
    # that is `unsupported` only by design (no OCR) is covered by ③ and does
    # not add ⑤. A status outside the test plan's list also counts as ⑤.
    # A node nested deeper than 3 levels (top-level attachment = level 1) is
    # ⑤ whatever its status.
    if status != "ok" and not (typ == "image" and status == "unsupported"):
        clauses.add("5")
    if depth > KYC_MAX_DEPTH:
        clauses.add("5")
    if att.get("text"):
        texts.append(att["text"])
    for ch in att.get("children") or []:
        _kyc_node(ch, depth + 1, clauses, texts)


def kyc(inp):
    """C-RED-0 for one top-level attachment (test plan §3 `attachments` item) → {maybe_kyc, clauses}."""
    # READING (R-E4-01): a top-level attachment is «possibly KYC» when any
    # clause holds for it or for any attachment nested in it (R-RED-02
    # «递归检查嵌套附件»; TC-RED-04 «嵌套 .eml 里的护照 PDF → 外层附件是»).
    # `clauses` is the union over the whole tree. For ② «全部文字内容（含嵌套
    # 附件）» the texts of the attachment and of all its descendants are one
    # pool: the MRZ is looked for line by line in each text, the ① words and
    # the three birth / nationality words are matched in each text on its own
    # (a phrase never runs across two texts), and «任意两个» counts distinct
    # words over the whole pool — `date of birth` in an outer .eml and
    # `nationality` in the PDF inside it hold ② for the outer attachment.
    # E6 (PRD v0.7.25 C-RED-0 ③ exception, test plan §3 v0.7.21): with
    # `eml_path`, a top-level attachment that passes the inline-signature
    # check is judged only by ①. ⓓ comes from the export's parse_status
    # (`blocked` / `over_limit` fail it). Without `eml_path` (old input
    # shape) there is no exception.
    # READING (R-E6-10): the exception is tried only for a top-level item
    # with an integer `ordinal` (B.1 numbering) and no `children`; any other
    # parse_status counts as «扫描通过、未超限» for ⓓ. Output keeps
    # {maybe_kyc, clauses} and adds `inline_signature` (the reason) when
    # `eml_path` is given.
    if inp.get("eml_path"):
        status = inp.get("parse_status")
        scan = status if status in ("blocked", "over_limit") else "passed"
        ok, reason, part = False, "a:children", None
        if not inp.get("children"):
            ok, reason, part = _inline_check({"eml_path": inp["eml_path"], "ordinal": inp.get("ordinal"),
                                              "scan": scan, "thresholds": inp.get("thresholds"),
                                              "mime_failed": inp.get("mime_failed")})
        if ok:
            names = [inp.get("filename") or ""] + _eml_names(part)
            hit = any(_kyc_word_hits(nm, KYC_WORDS) for nm in names if nm)
            return {"maybe_kyc": hit, "clauses": ["1"] if hit else [], "inline_signature": reason}
        res = kyc({k: v for k, v in inp.items() if k not in ("eml_path", "thresholds")})
        res["inline_signature"] = reason
        return res
    clauses, texts = set(), []
    _kyc_node(inp, 1, clauses, texts)
    birth = set()
    for t in texts:
        if _has_mrz(t) or _kyc_word_hits(t, KYC_WORDS):
            clauses.add("2")
        birth |= _kyc_word_hits(t, KYC_BIRTH_WORDS) & set(KYC_BIRTH_WORDS)
    if len(birth) >= 2:
        clauses.add("2")
    out = sorted(clauses)
    return {"maybe_kyc": bool(out), "clauses": out}


# ---------------------------------------------------------------------------
# E6: C-RED-0 ③ exception for small inline signature images (PRD v0.7.25,
# C-RED-0 ③ ⓐ-ⓕ and appendix B). Everything not covered or not readable is
# not an exception (fails closed). The HTML scan is written by hand (B.4: no
# html.parser).
# ---------------------------------------------------------------------------

import base64 as _b64
import html as _html_mod
import zlib as _zlib
from email.header import decode_header as _decode_header, make_header as _make_header

_AWS = " \t\n\r\x0c"  # «ASCII 空白» (appendix B preamble)
_AWS_B = b" \t\n\r\x0c"
_ASCII_LOWER = {c: c + 32 for c in range(0x41, 0x5B)}


def _alower(s: str) -> str:
    """«不区分大小写» only for ASCII letters (appendix B preamble)."""
    return s.translate(_ASCII_LOWER)


def _astrip(s: str) -> str:
    return s.strip(_AWS)


# READING: R-E6-03. B.1 does not specify the system's MIME part-count cap.
# Do not invent one: independently reject unreadable MIME, and accept an
# optional mime_failed=True system-state input to veto every exception.
# The actual export needs that state (or an equivalent upstream guarantee)
# for cases where the system failed but this independent parser succeeds.


class _MimeError(Exception):
    pass


class _Part:
    __slots__ = ("headers", "body", "children", "type", "path")

    def __init__(self, headers, body):
        self.headers = headers  # [(lower-case name, raw value as latin-1 str, unfolded)]
        self.body = body  # raw bytes
        self.children = []
        self.type = ""

    def all(self, name):
        return [v for k, v in self.headers if k == name]

    def first(self, name):
        for k, v in self.headers:
            if k == name:
                return v
        return None


def _split_head_body(raw: bytes):
    """Header block and body: the body starts after the first empty line."""
    if raw.startswith(b"\r\n"):
        return b"", raw[2:]
    if raw.startswith(b"\n"):
        return b"", raw[1:]
    cands = [(i, 3) for i in [raw.find(b"\n\r\n")] if i >= 0] + [(i, 2) for i in [raw.find(b"\n\n")] if i >= 0]
    if not cands:
        # READING (R-E6-02): no empty line -> everything is header, empty body.
        return raw, b""
    i, k = min(cands)
    return raw[:i + 1], raw[i + k:]


def _parse_headers(block: bytes):
    """[(name, value)]: raw bytes as latin-1 (no RFC 2047 decoding, B.1), folded lines joined."""
    out = []
    for line in block.split(b"\n"):
        if line.endswith(b"\r"):
            line = line[:-1]
        if line == b"":
            continue
        if line[:1] in (b" ", b"\t"):
            if not out:
                raise _MimeError("continuation line before any header")
            # RFC 5322 unfolding: remove the line break only, keep the WSP.
            out[-1][1] += line.decode("latin-1")
            continue
        # READING (R-E6-02): a header line without a colon (or with an empty
        # name) cannot be read -> MIME decoding failure (no exception at all).
        c = line.find(b":")
        if c <= 0:
            raise _MimeError("header line without a name")
        name = line[:c].rstrip(b" \t").decode("latin-1")
        if not name:
            raise _MimeError("empty header name")
        out.append([_alower(name), line[c + 1:].decode("latin-1")])
    return [(k, v) for k, v in out]


def _split_params(value: str):
    """Header value split at `;` outside quoted strings: (first part, [(name, value)])."""
    segs, cur, q, esc = [], [], False, False
    for ch in value:
        if esc:
            cur.append(ch)
            esc = False
        elif q and ch == "\\":
            cur.append(ch)
            esc = True
        elif ch == '"':
            q = not q
            cur.append(ch)
        elif ch == ";" and not q:
            segs.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    segs.append("".join(cur))
    params = []
    for s in segs[1:]:
        if "=" not in s:
            continue
        k, v = s.split("=", 1)
        k, v = _alower(_astrip(k)), _astrip(v)
        if v.startswith('"'):
            buf, i, esc = [], 1, False
            while i < len(v):
                ch = v[i]
                if esc:
                    buf.append(ch)
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    break
                else:
                    buf.append(ch)
                i += 1
            v = "".join(buf)
        params.append((k, v))
    return segs[0], params


def _pct_bytes(s: str) -> bytes:
    out, i = bytearray(), 0
    while i < len(s):
        if s[i] == "%" and _is_hex2(s[i + 1:i + 3]):
            out.append(int(s[i + 1:i + 3], 16))
            i += 3
        else:
            out += s[i].encode("latin-1", "replace")
            i += 1
    return bytes(out)


def _is_hex2(s: str) -> bool:
    return len(s) == 2 and all(c in "0123456789abcdefABCDEF" for c in s)


def _decode_charset(b: bytes, cs: str) -> str:
    try:
        return b.decode(cs or "utf-8", "replace")
    except LookupError:
        return b.decode("utf-8", "replace")


def _get_param(params, name: str):
    """RFC 2231-aware parameter value (str) or None; the first of duplicates."""
    # READING (R-E6-02): an extended `name*` (or `name*0*` / `name*0` sections)
    # wins over a plain `name` (RFC 2231 §4); duplicates: the first. Without a
    # charset in the extended value, or an unknown one, UTF-8 with
    # replacement. A plain value's raw bytes are read as UTF-8.
    d = {}
    for k, v in params:
        d.setdefault(k, v)
    if name + "*" in d:
        v = d[name + "*"]
        parts = v.split("'", 2)
        if len(parts) == 3:
            return _decode_charset(_pct_bytes(parts[2]), parts[0])
        return _decode_charset(_pct_bytes(v), "utf-8")
    if name + "*0" in d or name + "*0*" in d:
        buf, cs, i = bytearray(), "utf-8", 0
        while True:
            if name + "*%d*" % i in d:
                v = d[name + "*%d*" % i]
                if i == 0:
                    parts = v.split("'", 2)
                    if len(parts) == 3:
                        cs, v = parts[0] or "utf-8", parts[2]
                buf += _pct_bytes(v)
            elif name + "*%d" % i in d:
                buf += d[name + "*%d" % i].encode("latin-1", "replace")
            else:
                break
            i += 1
        return _decode_charset(bytes(buf), cs)
    if name in d:
        return d[name].encode("latin-1", "replace").decode("utf-8", "replace")
    return None


def _first_token(value) -> str:
    """Part before the first `;`, ASCII whitespace trimmed, ASCII lower case (B.1)."""
    if value is None:
        return ""
    return _alower(_astrip(value.split(";", 1)[0]))


def _mime_type(p: _Part) -> str:
    t = _first_token(p.first("content-type"))
    return t or "text/plain"


def _split_multipart(body: bytes, boundary: bytes):
    """Body parts between `--boundary` lines; MIME error when truncated or malformed."""
    delim = b"--" + boundary
    parts, start, pos, n, seen_first = [], None, 0, len(body), False
    while pos <= n:
        j = body.find(b"\n", pos)
        end = n if j < 0 else j
        line = body[pos:end]
        if line.endswith(b"\r"):
            line = line[:-1]
        stripped = line.rstrip(b" \t")
        if stripped == delim or stripped == delim + b"--":
            if start is not None:
                # The line break before the delimiter belongs to the delimiter.
                stop = pos
                if stop > start and body[stop - 1:stop] == b"\n":
                    stop -= 1
                    if stop > start and body[stop - 1:stop] == b"\r":
                        stop -= 1
                parts.append(body[start:max(start, stop)])
            seen_first = True
            if stripped == delim + b"--":
                return parts
            start = n if j < 0 else j + 1
        if j < 0:
            break
        pos = j + 1
    if not seen_first:
        raise _MimeError("no boundary delimiter")
    raise _MimeError("no closing boundary (truncated)")


def _parse_part(raw: bytes, depth: int, counter: list):
    counter[0] += 1
    head, body = _split_head_body(raw)
    p = _Part(_parse_headers(head), body)
    p.type = _mime_type(p)
    if p.type.startswith("multipart/"):
        _, params = _split_params(p.first("content-type") or "")
        b = _get_param(params, "boundary")
        if not b:
            raise _MimeError("multipart without boundary")
        for chunk in _split_multipart(body, b.encode("utf-8")):
            p.children.append(_parse_part(chunk, depth + 1, counter))
    # message/rfc822 (and every other non-multipart type) is a leaf: not opened (B.1).
    return p


def _walk(p: _Part):
    yield p
    for c in p.children:
        yield from _walk(c)


def _filename(p: _Part):
    """B.1 file name: Content-Disposition `filename` (RFC 2231) if non-empty, else Content-Type `name`."""
    cd = p.first("content-disposition")
    if cd is not None:
        f = _get_param(_split_params(cd)[1], "filename")
        if f:
            return f
    ct = p.first("content-type")
    if ct is not None:
        return _get_param(_split_params(ct)[1], "name") or ""
    return ""


def _is_attachment(p: _Part) -> bool:
    return (_first_token(p.first("content-disposition")) == "attachment" or bool(_filename(p))
            or p.type == "message/rfc822" or p.type not in ("text/plain", "text/html"))


def _cid_middle(value):
    """B.2 Content-ID shape: `<middle>`, middle non-empty ASCII 0x21-0x7E without `<` `>`; lower-cased."""
    v = _astrip(value)
    if len(v) < 3 or v[0] != "<" or v[-1] != ">":
        return None
    mid = v[1:-1]
    if any(not (0x21 <= ord(c) <= 0x7E) or c in "<>" for c in mid):
        return None
    return _alower(mid)


def _strict_b64(body: bytes):
    """B.3 strict base64 decoding, or None."""
    s = bytes(c for c in body if c not in _AWS_B)
    if len(s) % 4:
        return None
    k = len(s) - len(s.rstrip(b"="))
    if k > 2:
        return None
    core = s[:len(s) - k]
    if any(c not in _B64_ALPHABET for c in core):
        return None
    try:
        return _b64.b64decode(s, validate=True)
    except Exception:  # noqa: BLE001
        return None


_B64_ALPHABET = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")


def _qp_decode(body: bytes) -> bytes:
    """B.4 quoted-printable (RFC 2045): soft breaks removed, =XX decoded, other `=` kept."""
    out, i, n = bytearray(), 0, len(body)
    while i < n:
        c = body[i]
        if c == 0x3D:  # '='
            if body[i + 1:i + 3] == b"\r\n":
                i += 3
                continue
            if body[i + 1:i + 2] == b"\n":
                i += 2
                continue
            h = body[i + 1:i + 3]
            if len(h) == 2 and all(x in b"0123456789abcdefABCDEF" for x in h):
                out.append(int(h, 16))
                i += 3
                continue
        out.append(c)
        i += 1
    return bytes(out)


# B.4 charsets. READING (R-E6-04): iso-8859-12 is in the named range but does
# not exist (Python has no codec), so it falls back to UTF-8 like any other
# unrecognised name. The charset parameter is read like other parameters
# (quotes removed, ASCII whitespace trimmed, ASCII case-insensitive).
_HTML_CHARSETS = {"utf-8": "utf-8", "us-ascii": "ascii"}
_HTML_CHARSETS.update({"iso-8859-%d" % i: "iso-8859-%d" % i for i in range(1, 16) if i != 12})
_HTML_CHARSETS.update({"windows-%d" % i: "cp%d" % i for i in range(1250, 1259)})


def _html_text(p: _Part):
    """B.4: an HTML body part as text, or None when its base64 does not decode."""
    cte = _alower(_astrip(p.first("content-transfer-encoding") or ""))
    if cte == "base64":
        b = _strict_b64(p.body)
        if b is None:
            return None
    elif cte == "quoted-printable":
        b = _qp_decode(p.body)
    else:
        b = p.body
    cs = _get_param(_split_params(p.first("content-type") or "")[1], "charset")
    codec = _HTML_CHARSETS.get(_alower(_astrip(cs or "")), "utf-8")
    return b.decode(codec, "replace")


_RAW_IGNORE = {"script", "style", "template", "noscript", "textarea", "title", "xmp", "iframe", "noembed",
               "noframes", "svg", "math"}


def _is_alpha(c: str) -> bool:
    return ("a" <= c <= "z") or ("A" <= c <= "Z")


def _scan_tag(s: str, i: int):
    """Read the tag at s[i] ('<' + letter, or '</' + letter) by the B.4 tokenizer states.

    Returns (name, {attr: first value}, index after '>') or None at end of input."""
    n = len(s)
    j = i + 1
    if s[j] == "/":
        j += 1
    k = j
    while k < n and s[k] not in _AWS and s[k] not in "/>":
        k += 1
    name = _alower(s[j:k])
    attrs = {}
    p = k
    while True:
        while p < n and (s[p] in _AWS or s[p] == "/"):  # before attribute name; `/` separates
            p += 1
        if p >= n:
            return None
        if s[p] == ">":
            return name, attrs, p + 1
        q = p + 1 if s[p] == "=" else p  # WHATWG: a leading `=` belongs to the name
        while q < n and s[q] not in _AWS and s[q] not in "/=>":
            q += 1
        aname = _alower(s[p:q])
        p = q
        while p < n and s[p] in _AWS:  # after attribute name
            p += 1
        if p >= n:
            return None
        if s[p] != "=":
            attrs.setdefault(aname, "")
            continue
        p += 1
        while p < n and s[p] in _AWS:  # before attribute value
            p += 1
        if p >= n:
            return None
        c = s[p]
        if c in "\"'":
            e = s.find(c, p + 1)
            if e < 0:
                return None
            val, p = s[p + 1:e], e + 1
        elif c == ">":
            attrs.setdefault(aname, "")
            return name, attrs, p + 1
        else:
            q = p
            while q < n and s[q] not in _AWS and s[q] != ">":
                q += 1
            val, p = s[p:q], q
        attrs.setdefault(aname, val)


def _end_of_raw(s: str, low: str, start: int, name: str) -> int:
    """Index after the end tag `</name` (+ ws, `/` or `>`) found from `start`, or -1."""
    pat = "</" + name
    i = start
    while True:
        i = low.find(pat, i)
        if i < 0:
            return -1
        k = i + len(pat)
        if k < len(s) and (s[k] in _AWS or s[k] in "/>"):
            r = _scan_tag(s, i)
            return -1 if r is None else r[2]
        i = k


def _html_img_srcs(s: str):
    """B.4 token scan: the first `src` value (raw, may be None) of every `img` start tag."""
    # READING (R-E6-05): `</` + letter is an end tag read with the same
    # attribute states (so a `>` inside quotes does not end it); `</>` is
    # skipped; `</` + anything else is ignored up to the next `>` (WHATWG
    # bogus comment). A tag cut off by the end of the part is dropped and
    # nothing after it counts. A raw-text element's start tag that is
    # self-closing (`<svg/>`) still starts the ignored region (B.4 «开始标记到
    # 同名结束标记»). The end tag is found by its name (ASCII case-insensitive)
    # followed by ASCII whitespace, `/` or `>`.
    out, i, n = [], 0, len(s)
    low = _alower(s)
    while True:
        i = s.find("<", i)
        if i < 0 or i + 1 >= n:
            break
        nx = s[i + 1]
        if s.startswith("<!--", i):
            e = s.find("-->", i + 2)  # `<!-->` and `<!--->` are complete comments
            if e < 0:
                break
            i = e + 3
            continue
        if nx in "!?":
            e = s.find(">", i + 2)
            if e < 0:
                break
            i = e + 1
            continue
        if nx == "/":
            if i + 2 < n and _is_alpha(s[i + 2]):
                r = _scan_tag(s, i)
                if r is None:
                    break
                i = r[2]
                continue
            if i + 2 < n and s[i + 2] == ">":
                i += 3
                continue
            e = s.find(">", i + 2)
            if e < 0:
                break
            i = e + 1
            continue
        if _is_alpha(nx):
            r = _scan_tag(s, i)
            if r is None:
                break
            name, attrs, end = r
            if name == "img":
                out.append(attrs.get("src"))
            if name == "plaintext":
                break
            if name in _RAW_IGNORE:
                end = _end_of_raw(s, low, end, name)
                if end < 0:
                    break
            i = end
            continue
        i += 1
    return out


def _cid_of_src(v):
    """B.4: an `img src` value -> the referenced Content-ID (lower case) or None."""
    if v is None:
        return None
    v = _astrip(_html_mod.unescape(v))
    if _alower(v[:4]) != "cid:":
        return None
    rest, out, i = v[4:], bytearray(), 0
    while i < len(rest):
        if rest[i] == "%" and _is_hex2(rest[i + 1:i + 3]):
            out.append(int(rest[i + 1:i + 3], 16))
            i += 3
        else:
            out += rest[i].encode("utf-8", "surrogatepass")
            i += 1
    return _alower(out.decode("utf-8", "replace"))


class _ImgFail(Exception):
    pass


_IMG_SIGS = (b"\xff\xd8\xff", b"\x89PNG", b"GIF8")


def _has_img_sig(b) -> bool:
    return any(x in b for x in _IMG_SIGS)


_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_PNG_ALLOWED = {b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"gAMA", b"cHRM", b"sRGB", b"iCCP", b"pHYs",
                b"bKGD", b"sBIT", b"tIME", b"tEXt", b"iTXt", b"eXIf", b"iDOT", b"cICP"}
_PNG_EXACT = {b"iDOT": 28, b"cICP": 4}
META_CAP = 16384


def _png(d: bytes):
    p, n = 8, len(d)
    ihdr, idat, meta_total, meta_all = None, bytearray(), 0, bytearray()
    first, iend = True, False
    while p < n:
        if n - p < 12:
            raise _ImgFail("png:truncated")
        length = int.from_bytes(d[p:p + 4], "big")
        name = d[p + 4:p + 8]
        if length > n - p - 12:
            raise _ImgFail("png:length")
        data = d[p + 8:p + 8 + length]
        if _zlib.crc32(name + data) != int.from_bytes(d[p + 8 + length:p + 12 + length], "big"):
            raise _ImgFail("png:crc")
        p += 12 + length
        if first and name != b"IHDR":
            raise _ImgFail("png:first_not_ihdr")
        first = False
        if name not in _PNG_ALLOWED:
            raise _ImgFail("png:chunk_not_allowed")
        if name in _PNG_EXACT and length != _PNG_EXACT[name]:
            raise _ImgFail("png:chunk_size")
        if name == b"IHDR":
            if ihdr is not None or length != 13:
                raise _ImgFail("png:ihdr")
            ihdr = data
        elif name == b"IDAT":
            idat += data
        elif name in (b"tEXt", b"iTXt", b"eXIf", b"iCCP"):
            if length > META_CAP:
                raise _ImgFail("png:chunk_over_16384")
            if name != b"iCCP":
                meta_total += length
                if meta_total > META_CAP:
                    raise _ImgFail("png:text_total_over_16384")
                if _has_img_sig(data):
                    raise _ImgFail("png:signature_in_text")
                meta_all += data
            if name == b"iTXt":
                z = data.find(b"\x00")
                if z < 0 or z + 1 >= len(data):
                    raise _ImgFail("png:itxt_truncated")
                # READING (R-E6-06): only compression flag 0 passes; 1 fails by
                # the text, any other value is not covered and fails too.
                if data[z + 1] != 0:
                    raise _ImgFail("png:itxt_compressed")
        elif name == b"IEND":
            # READING (R-E6-06): IEND with data is not covered -> fails.
            if length != 0:
                raise _ImgFail("png:iend_data")
            if p != n:
                raise _ImgFail("png:data_after_iend")
            iend = True
            break
    if not iend:
        raise _ImgFail("png:no_iend")
    if ihdr is None:
        raise _ImgFail("png:no_ihdr")
    # READING (R-E6-06): the signature check also runs over all tEXt / iTXt /
    # eXIf data joined (a signature split across two chunks fails too).
    if _has_img_sig(idat) or _has_img_sig(meta_all):
        raise _ImgFail("png:signature_in_idat")
    return int.from_bytes(ihdr[0:4], "big"), int.from_bytes(ihdr[4:8], "big")


def _jpeg(d: bytes):
    p, n = 2, len(d)
    size, sos, app_total, scan = None, False, 0, bytearray()
    while True:
        if p >= n:
            raise _ImgFail("jpeg:no_eoi")
        if d[p] != 0xFF:
            raise _ImgFail("jpeg:expected_marker")
        while p < n and d[p] == 0xFF:  # fill bytes before a marker
            p += 1
        if p >= n:
            raise _ImgFail("jpeg:no_eoi")
        m = d[p]
        p += 1
        if m == 0xD9:
            if size is None:
                raise _ImgFail("jpeg:no_frame_header")
            if not sos:
                raise _ImgFail("jpeg:no_sos")
            if p != n:
                raise _ImgFail("jpeg:data_after_eoi")
            break
        if m == 0xD8:
            raise _ImgFail("jpeg:second_soi")
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            raise _ImgFail("jpeg:rst_outside_scan")
        if m == 0xDC:
            raise _ImgFail("jpeg:dnl")
        is_sof = 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC)
        is_app = 0xE0 <= m <= 0xEF
        if not (is_sof or is_app or m in (0xC4, 0xCC, 0xDB, 0xDD, 0xDA, 0xFE)):
            raise _ImgFail("jpeg:marker_not_allowed")
        if n - p < 2:
            raise _ImgFail("jpeg:truncated")
        length = int.from_bytes(d[p:p + 2], "big")
        if length < 2 or length > n - p:
            raise _ImgFail("jpeg:length")
        seg = d[p + 2:p + length]
        p += length
        if is_sof:
            if size is not None or sos:
                raise _ImgFail("jpeg:frame_header")
            if len(seg) < 5:
                raise _ImgFail("jpeg:frame_header_short")
            size = (int.from_bytes(seg[3:5], "big"), int.from_bytes(seg[1:3], "big"))
        elif is_app or m == 0xFE:
            icc = m == 0xE2 and seg.startswith(b"ICC_PROFILE\x00")
            xmp = m == 0xE1 and seg.startswith(b"http://ns.adobe.com/xap/1.0/\x00")
            if _has_img_sig(seg):
                raise _ImgFail("jpeg:signature_in_app")
            if m == 0xE2 and seg.startswith(b"MPF\x00"):
                raise _ImgFail("jpeg:mpf")
            if len(seg) > 4096 and (not (icc or xmp) or len(seg) > META_CAP):
                raise _ImgFail("jpeg:app_segment_size")
            if not icc:
                app_total += len(seg)
                if app_total > META_CAP:
                    raise _ImgFail("jpeg:app_total_over_16384")
        elif m == 0xDA:
            sos = True
            while True:
                if p >= n:
                    raise _ImgFail("jpeg:truncated_scan")
                b = d[p]
                if b != 0xFF:
                    scan.append(b)
                    p += 1
                    continue
                if p + 1 >= n:
                    raise _ImgFail("jpeg:ff_last_byte")
                nb = d[p + 1]
                if nb == 0x00 or 0xD0 <= nb <= 0xD7:
                    scan += d[p:p + 2]
                    p += 2
                    continue
                if nb == 0xFF:
                    p += 1
                    continue
                break  # this FF starts the next marker
    if _has_img_sig(scan):
        raise _ImgFail("jpeg:signature_in_scan")
    return size


def _gif_subblocks(d: bytes, p: int):
    data = bytearray()
    while True:
        if p >= len(d):
            raise _ImgFail("gif:truncated")
        ln = d[p]
        p += 1
        if ln == 0:
            return data, p
        if p + ln > len(d):
            raise _ImgFail("gif:truncated")
        data += d[p:p + ln]
        p += ln


def _gif(d: bytes):
    n = len(d)
    if n < 13:
        raise _ImgFail("gif:truncated")
    w, h, packed = int.from_bytes(d[6:8], "little"), int.from_bytes(d[8:10], "little"), d[10]
    p = 13
    if packed & 0x80:
        p += 3 * (2 ** ((packed & 7) + 1))
    frames, img = 0, bytearray()
    while True:
        if p >= n:
            raise _ImgFail("gif:no_trailer")
        b = d[p]
        p += 1
        if b == 0x3B:
            if p != n:
                raise _ImgFail("gif:data_after_trailer")
            break
        if b == 0x2C:
            frames += 1
            if frames > 1:
                raise _ImgFail("gif:more_than_one_frame")
            if n - p < 9:
                raise _ImgFail("gif:truncated")
            left, top = int.from_bytes(d[p:p + 2], "little"), int.from_bytes(d[p + 2:p + 4], "little")
            fw, fh, pk = int.from_bytes(d[p + 4:p + 6], "little"), int.from_bytes(d[p + 6:p + 8], "little"), d[p + 8]
            p += 9
            # READING (R-E6-07): a frame with width or height 0 is not covered -> fails.
            if fw == 0 or fh == 0:
                raise _ImgFail("gif:frame_zero")
            if left + fw > w or top + fh > h:
                raise _ImgFail("gif:frame_outside_canvas")
            if pk & 0x80:
                p += 3 * (2 ** ((pk & 7) + 1))
            if p >= n:
                raise _ImgFail("gif:truncated")
            p += 1  # LZW minimum code size
            data, p = _gif_subblocks(d, p)
            img += data
        elif b == 0x21:
            if p >= n:
                raise _ImgFail("gif:truncated")
            label = d[p]
            p += 1
            if label == 0xF9:
                if p + 6 > n or d[p] != 4 or d[p + 5] != 0:
                    raise _ImgFail("gif:graphic_control")
                p += 6
            elif label in (0xFE, 0xFF, 0x01):
                data, p = _gif_subblocks(d, p)
                if len(data) > 4096:
                    raise _ImgFail("gif:extension_over_4096")
                if _has_img_sig(data):
                    raise _ImgFail("gif:signature_in_extension")
            else:
                raise _ImgFail("gif:extension_not_allowed")
        else:
            raise _ImgFail("gif:block_not_allowed")
    if _has_img_sig(img):
        raise _ImgFail("gif:signature_in_image_data")
    return w, h


def _image_size(d: bytes):
    """B.5: (width, height) or raise _ImgFail."""
    if d.startswith(_PNG_SIG):
        w, h = _png(d)
    elif d.startswith(b"\xff\xd8"):
        w, h = _jpeg(d)
    elif d.startswith(b"GIF87a") or d.startswith(b"GIF89a"):
        w, h = _gif(d)
    else:
        raise _ImgFail("signature")
    if w == 0 or h == 0:
        raise _ImgFail("zero_size")
    return w, h


INLINE_DEFAULT = {"max_long_side": 400, "max_short_side": 150, "max_bytes": 51200}
INLINE_HARD_CAP = {"max_long_side": 1280, "max_short_side": 300, "max_bytes": 102400}


def inline_thresholds(t):
    """B.6 `kyc.inline_image`: defaults, or a configuration that must stay within the hard caps."""
    # READING (R-E6-08): a missing key keeps its default; an unknown key, a
    # value that is not a positive integer, or a value above the hard cap is
    # a configuration load error (raised; the CLI reports ok: false).
    out = dict(INLINE_DEFAULT)
    if t is None:
        return out
    if not isinstance(t, dict):
        raise ValueError("kyc.inline_image must be an object")
    for k, v in t.items():
        if k not in INLINE_HARD_CAP:
            raise ValueError("kyc.inline_image: unknown key %s" % k)
        if isinstance(v, bool) or not isinstance(v, int) or v < 1:
            raise ValueError("kyc.inline_image.%s must be a positive integer" % k)
        if v > INLINE_HARD_CAP[k]:
            raise ValueError("kyc.inline_image.%s above the hard cap %d" % (k, INLINE_HARD_CAP[k]))
        out[k] = v
    return out


def _outer_parts(raw: bytes):
    """B.1: (attachments in order, HTML body parts, Content-ID counts) of the outer message."""
    root = _parse_part(raw, 0, [0])
    atts, html_parts, counts = [], [], {}
    for p in _walk(root):
        # B.2 duplicate check: every well-formed Content-ID header of every
        # outer part (root, containers, body parts, attachments).
        for v in p.all("content-id"):
            m = _cid_middle(v)
            if m is not None:
                counts[m] = counts.get(m, 0) + 1
        if p.children or p.type.startswith("multipart/"):
            continue
        if _is_attachment(p):
            atts.append(p)
        elif p.type == "text/html":
            html_parts.append(p)
    return atts, html_parts, counts


def _inline_check(inp):
    """(exempt, reason, attachment part or None) for C-RED-0 ③'s exception."""
    th = inline_thresholds(inp.get("thresholds"))
    if inp.get("mime_failed") is True:
        return False, "mime_failed:system", None
    try:
        with open(inp["eml_path"], "rb") as fh:
            raw = fh.read()
    except OSError:
        return False, "mime_unreadable", None
    try:
        atts, html_parts, counts = _outer_parts(raw)
    except (_MimeError, RecursionError) as e:
        return False, "mime_failed:%s" % e, None
    ordinal = inp.get("ordinal")
    # ⓐ: only outer attachments are numbered (B.1); message/rfc822 is a leaf.
    if isinstance(ordinal, bool) or not isinstance(ordinal, int) or not 0 <= ordinal < len(atts):
        return False, "a:no_such_attachment", None
    part = atts[ordinal]
    # ⓑ
    cids = part.all("content-id")
    if len(cids) != 1:
        return False, "b:content_id_count", part
    cid = _cid_middle(cids[0])
    if cid is None:
        return False, "b:content_id_shape", part
    if counts.get(cid, 0) >= 2:
        return False, "b:content_id_duplicate", part
    refs = set()
    for hp in html_parts:
        t = _html_text(hp)
        if t is not None:
            refs |= {c for c in map(_cid_of_src, _html_img_srcs(t)) if c is not None}
    if cid not in refs:
        return False, "b:not_referenced", part
    # ⓒ
    cds = part.all("content-disposition")
    if len(cds) > 1:
        return False, "c:disposition_count", part
    if cds and _first_token(cds[0]) != "inline":
        return False, "c:disposition", part
    # ⓓ
    if inp.get("scan") != "passed":
        return False, "d:scan", part
    # ⓔ
    ctes = part.all("content-transfer-encoding")
    if len(ctes) != 1 or _alower(_astrip(ctes[0])) != "base64":
        return False, "e:transfer_encoding", part
    data = _strict_b64(part.body)
    if data is None:
        return False, "e:base64", part
    try:
        w, h = _image_size(data)
    except _ImgFail as e:
        return False, "e:%s" % e, part
    # ⓕ
    if max(w, h) > th["max_long_side"]:
        return False, "f:long_side", part
    if min(w, h) > th["max_short_side"]:
        return False, "f:short_side", part
    if len(data) > th["max_bytes"]:
        return False, "f:bytes", part
    return True, "inline_signature", part


def inline_signature(inp):
    """C-RED-0 ③ exception (PRD appendix B) for the outer attachment `ordinal` of `eml_path`."""
    ok, reason, _ = _inline_check(inp)
    return {"exempt": ok, "reason": reason}


def _eml_names(part):
    """File names of the eml part for ①: B.1 file name, Content-Type `name`, and their RFC 2047 decodings."""
    # READING (R-E6-09): for an exempt image ① is checked on the export's
    # `filename` and also on the names the oracle reads itself (the
    # Content-Disposition `filename` and the Content-Type `name`, each as
    # written and RFC 2047-decoded): any hit holds ① (fails closed).
    names = [_filename(part)]
    ct = part.first("content-type")
    if ct is not None:
        names.append(_get_param(_split_params(ct)[1], "name") or "")
    out = []
    for nm in names:
        if not nm:
            continue
        out.append(nm)
        try:
            out.append(str(_make_header(_decode_header(nm))))
        except Exception:  # noqa: BLE001
            pass
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

FUNCTIONS = {
    "normalize": normalize,
    "wordlist_match": wordlist_match,
    "parse_amount_number": parse_amount_number,
    "amounts": amounts,
    "mt103": mt103,
    "pacs008": pacs008,
    "uetr": uetr,
    "references": references,
    "accounts": accounts,
    "dates": dates,
    "esign": esign,
    "redact": redact,
    "name_similarity": name_similarity,
    "signals": signals,
    "authenticated_sender": authenticated_sender,
    "audit_hash": audit_hash,
    "verify_chain": verify_chain,
    # E3
    "working_days_after": working_days_after,
    "due_at": due_at,
    "follow_up_at": follow_up_at,
    "due_state": due_state,
    "queue": queue,
    "risk": risk,
    "risk_adjust": risk_adjust,
    "may_disclose": may_disclose,
    "ledger_state": ledger_state,
    "template": template,
    "reply_check": reply_check,
    "fill": fill,
    "recipient": recipient,
    "actions": actions,
    "lead_confirmed": lead_confirmed,
    # E4
    "kyc": kyc,
    # E6
    "inline_signature": inline_signature,
}


def call(fn: str, inp):
    if fn not in FUNCTIONS:
        raise ValueError("unknown function: %s" % fn)
    return FUNCTIONS[fn](inp)


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            out = {"ok": True, "output": call(req["fn"], req.get("input") or {})}
        except Exception as e:  # noqa: BLE001 - every failure is reported per line
            out = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
        sys.stdout.write(json.dumps(out, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
