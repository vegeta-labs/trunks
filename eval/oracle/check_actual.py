#!/usr/bin/env python3
"""PRD §6 «规则一致（实际输入）»: recompute risk and template from the system's
actual raw inputs and compare with the system's results.

Usage: python3 eval/oracle/check_actual.py [--require-attachments] <dir>

With --require-attachments (before or after <dir>), a file without an
`attachments` list (missing or null) is reported as "<id> attachments missing"
and counts as a mismatch; an empty list is accepted.

<dir> holds one <id>.actual.json per sample (test plan §3, «E3「规则一致（实际
输入）」的导出格式», v0.7.12: raw inputs only), classes.json ([{id, risk_floor}]
in order) and calendar.json. The checker computes C-SIG-3 (authenticated
sender), C-LNK-5 (may disclose), C-DRF-6 (ledger state), the C-RSK-2a pressure
words and the C-RSK-2 account shapes itself, then risk (C-RSK) and template
(C-DRF-3 to 6). When a file has an `attachments` list (test plan §3, E4,
v0.7.13), it also recomputes C-RED-0 for every top-level attachment and
compares it with the system's `maybe_kyc`. Prints one line per mismatch
("<id> risk|template ..." or "<id> attachment <ordinal> maybe_kyc ...") and a
summary; exits 1 on any mismatch, 2 on a usage error. Written only from the
PRD, the test plan, eval/SCHEMA.md and eval/oracle/BRIEF.md (independent of
the TypeScript).
"""

from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle as O  # noqa: E402


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def sender_contact(a):
    """C-SIG-3: the one matching contact when the sender is authenticated, else None."""
    # READING (R-E3-25): `sender_contacts` are all contacts the From address
    # matches (C-LNK-1), deduplicated by contact_id; authenticated = exactly
    # one of them and `dmarc_pass` is true. A signal `auth_fail` that is true
    # also means "not authenticated" («任何一项失败»).
    seen, uniq = set(), []
    for c in a.get("sender_contacts") or []:
        cid = c.get("contact_id")
        if cid in seen:
            continue
        seen.add(cid)
        uniq.append(c)
    if len(uniq) != 1 or a.get("dmarc_pass") is not True or (a.get("signals") or {}).get("auth_fail") is True:
        return None
    return uniq[0]


def may_disclose(a):
    """C-LNK-5: linked commitment key in the authenticated contact's investor_ids or authorised_for."""
    c = sender_contact(a)
    key = (a.get("links") or {}).get("investor_id")
    return O.may_disclose({"authenticated_sender": c is not None, "commitment_key": key,
                           "contact_investor_ids": (c or {}).get("investor_ids") or [],
                           "contact_authorised_for": (c or {}).get("authorised_for") or []})["allowed"]


def ledger(a):
    """C-DRF-6 from the exported commitment (cash due, deal currency, snapshot ledger rows)."""
    key = (a.get("links") or {}).get("investor_id")
    cm = a.get("commitment")
    # READING (R-E3-28): no linked commitment, `commitment: null` or
    # `commitment.ledger: null` -> unknown. The bare investor ID is the part
    # of the commitment key after "::" (C-DIR-2 key «交易名::investor_id»).
    if key is None or cm is None or cm.get("ledger") is None:
        return "unknown"
    bare = key.split("::", 1)[1] if "::" in key else key
    return O.ledger_state({"ledger": cm["ledger"], "investor_id": bare, "commitment_key": key,
                           "deal_currency": cm.get("deal_currency"),
                           "cash_due_minor": cm["cash_due_minor"]})["state"]


def pressure_words(a):
    """C-RSK-2a pressure words: I-05 over each of `pressure_texts` (the class condition is in O.risk)."""
    # READING (R-E3-26): each text is matched on its own (a phrase does not
    # run across two texts).
    return any(O.wordlist_match({"text": t, "phrases": O.PRESSURE_PHRASES})["matched"]
               for t in a.get("pressure_texts") or [] if t)


def account_present(a):
    """C-RSK-2 «出现 IBAN 形状的串或英国账号»: a C-RED-1 [ACCOUNT] hit in any of `account_texts`."""
    # READING (R-E3-27): the C-RED-1 account patterns, regardless of check
    # digits: IBAN shapes, 8-digit numbers after account / acc / a/c or near
    # "sort code", and the C-EXT-4 UK pairs. A sort code alone is not an
    # account.
    for t in a.get("account_texts") or []:
        if t and any(k == "ACCOUNT" for _, _, k in O.redact_spans(O.normalize_text(t), [])):
            return True
    return False


def recompute(a, classes, calendar):
    ro = a.get("rule_output") or {}
    fields = a.get("fields") or {}
    adopted = list(a.get("classes") or [])
    # READING (R-E3-26): set B is `amounts_body`, set A is
    # rule_output.amounts_attachment.
    r = O.risk({
        "classes": classes, "adopted": adopted, "low": list(a.get("low_labels") or []),
        "signals": a.get("signals") or {}, "account_present": account_present(a),
        "uetr_candidates_invalid": ro.get("uetr_candidates_invalid") or [],
        "amounts_body": a.get("amounts_body") or [], "amounts_attachment": ro.get("amounts_attachment") or [],
        "attachment_blocked_or_over_limit": bool(ro.get("blocked_or_over_limit")),
        "pressure_text": None, "pressure_words": pressure_words(a),
        "planned_close_date": a.get("planned_close_date"), "received_at": a["received_at"],
        "calendar": calendar, "adjustment": None,
    })
    links = a.get("links") or {}
    tmpl = O.template({
        "classes": classes, "adopted": adopted, "risk": r["final"],
        "linked_commitment": links.get("investor_id") is not None,
        "ledger_state": ledger(a), "may_disclose": may_disclose(a),
        "evidence_value_dates": ro.get("evidence_value_dates") or [],
        "value_date": fields.get("value_date"), "payment_date": fields.get("payment_date"),
        "received_at": a["received_at"], "calendar": calendar,
    })["template"]
    return r["final"], tmpl


def kyc_mismatches(a):
    """C-RED-0: (ordinal, system, oracle) for every top-level attachment whose maybe_kyc differs."""
    # READING (R-E4-07): only top-level attachments are compared (a child's
    # own `maybe_kyc`, if exported, is ignored); a missing or non-boolean
    # system `maybe_kyc` is a mismatch. No `attachments` key (or null) = no
    # KYC check for that file; an empty list = nothing to check.
    out = []
    for i, att in enumerate(a.get("attachments") or []):
        mine = O.kyc(att)["maybe_kyc"]
        theirs = att.get("maybe_kyc")
        if theirs is not mine:
            out.append((att.get("ordinal", i), theirs, mine))
    return out


def main(argv):
    args = list(argv[1:])
    require_att = "--require-attachments" in args
    args = [x for x in args if x != "--require-attachments"]
    if len(args) != 1 or args[0].startswith("--"):
        sys.stderr.write("usage: check_actual.py [--require-attachments] <dir>\n")
        return 2
    d = args[0]
    classes = _load(os.path.join(d, "classes.json"))
    calendar = _load(os.path.join(d, "calendar.json"))
    files = sorted(glob.glob(os.path.join(d, "*.actual.json")))
    bad = 0
    for path in files:
        a = _load(path)
        sid = a.get("id") or os.path.basename(path).split(".")[0]
        mism = False
        try:
            risk, tmpl = recompute(a, classes, calendar)
        except Exception as e:  # noqa: BLE001 - reported per sample
            print("%s error %s: %s" % (sid, type(e).__name__, e))
            risk = tmpl = None
            mism = True
        if require_att and a.get("attachments") is None:
            print("%s attachments missing" % sid)
            mism = True
        try:
            for ordinal, theirs, mine in kyc_mismatches(a):
                print("%s attachment %s maybe_kyc system=%s oracle=%s" % (sid, ordinal, json.dumps(theirs), json.dumps(mine)))
                mism = True
        except Exception as e:  # noqa: BLE001 - reported per sample
            print("%s attachments error %s: %s" % (sid, type(e).__name__, e))
            mism = True
        if risk is not None and risk != a.get("risk"):
            print("%s risk system=%s oracle=%s" % (sid, a.get("risk"), risk))
            mism = True
        if risk is not None and tmpl != a.get("template"):
            print("%s template system=%s oracle=%s" % (sid, a.get("template"), tmpl))
            mism = True
        bad += mism
    print("%d samples, %d with mismatches" % (len(files), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
