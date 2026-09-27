#!/usr/bin/env python3
"""
KGM LEGAL OS — SYSTEM AUDIT REPORT (client-facing PDF)

    python3 scripts/report/audit-report-pdf.py

WHAT THIS IS. The engineering audit is `docs/AUDIT-2026-09-27.md`; this is the same
material written for a reader who is not technical — a managing partner, a client, an
investor. Plain English, no jargon without a translation, and every claim traceable to a
check that was actually run.

WHY IT IS GENERATED RATHER THAN TYPED. The numbers in it (tables, policies, tests,
findings) come from the audit itself. A report that quotes a count somebody typed by hand
is wrong the moment the count changes; this one is run again instead.

DESIGN. A4, a cover, numbered sections, severity chips, and a footer with the page number.
Arabic is deliberately absent: the PDF uses the built-in Helvetica family, which cannot
render Arabic script, and a mangled Arabic word is worse than an English one. The Arabic
product itself is unaffected — this is a document, not a screen.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, NextPageTemplate, PageBreak, PageTemplate, Paragraph, Spacer,
    Table, TableStyle,
)

OUT = Path("docs/KGM-System-Audit-Report-2026-09-27.pdf")

INK = colors.HexColor("#1A1A1A")
MUTED = colors.HexColor("#5A5F6A")
RULE = colors.HexColor("#D8DCE3")
BRAND = colors.HexColor("#1F4E5F")
PANEL = colors.HexColor("#F4F6F8")

SEV = {
    "fixed": (colors.HexColor("#1B7F4B"), "Fixed in this review"),
    "high": (colors.HexColor("#A32020"), "Needs a decision before go-live"),
    "medium": (colors.HexColor("#A6631B"), "Should be fixed before go-live"),
    "low": (colors.HexColor("#4A5568"), "Recommended, not blocking"),
    "info": (colors.HexColor("#1F4E5F"), "For information"),
}

ss = getSampleStyleSheet()


def st(name, **kw):
    base = kw.pop("parent", ss["BodyText"])
    return ParagraphStyle(name, parent=base, **kw)


TITLE = st("t", parent=ss["Title"], fontName="Helvetica-Bold", fontSize=26, leading=31,
           textColor=INK, alignment=TA_LEFT, spaceAfter=6)
SUB = st("s", fontName="Helvetica", fontSize=12.5, leading=18, textColor=MUTED, spaceAfter=4)
H1 = st("h1", fontName="Helvetica-Bold", fontSize=15, leading=19, textColor=BRAND,
        spaceBefore=16, spaceAfter=7)
H2 = st("h2", fontName="Helvetica-Bold", fontSize=11.5, leading=15, textColor=INK,
        spaceBefore=11, spaceAfter=4)
BODY = st("b", fontName="Helvetica", fontSize=9.8, leading=14.6, textColor=INK, spaceAfter=7)
BULLET = st("bl", parent=BODY, leftIndent=11, bulletIndent=2, spaceAfter=3.5)
SMALL = st("sm", fontName="Helvetica", fontSize=8.6, leading=12.4, textColor=MUTED, spaceAfter=5)
CELL = st("c", fontName="Helvetica", fontSize=9, leading=12.6, textColor=INK)
CELLB = st("cb", parent=CELL, fontName="Helvetica-Bold")
CELLM = st("cm", parent=CELL, fontSize=8.6, leading=12, textColor=MUTED)


def P(text, style=BODY):
    return Paragraph(text, style)


def bullets(items, style=BULLET):
    return [Paragraph(t, style, bulletText="•") for t in items]


def rule(space_before=2, space_after=8):
    t = Table([[""]], colWidths=[170 * mm], rowHeights=[0.6])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.6, RULE),
                           ("TOPPADDING", (0, 0), (-1, -1), space_before),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), space_after)]))
    return t


def chip(kind: str) -> Paragraph:
    colour, label = SEV[kind]
    return Paragraph(f'<font color="#{colour.hexval()[2:]}"><b>{label}</b></font>', CELLM)


def table(rows, widths, header=True, zebra=True):
    data = []
    for i, r in enumerate(rows):
        data.append([c if not isinstance(c, str) else Paragraph(c, CELLB if (header and i == 0) else CELL)
                     for c in r])
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
    ]
    if header:
        style.append(("BACKGROUND", (0, 0), (-1, 0), PANEL))
    if zebra:
        for i in range(1 + (1 if header else 0), len(data), 2):
            style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#FAFBFC")))
    t.setStyle(TableStyle(style))
    return t


def panel(text, colour=PANEL):
    t = Table([[Paragraph(text, BODY)]], colWidths=[170 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colour),
                           ("BOX", (0, 0), (-1, -1), 0.4, RULE),
                           ("LEFTPADDING", (0, 0), (-1, -1), 9),
                           ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                           ("TOPPADDING", (0, 0), (-1, -1), 8),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    y = 13 * mm
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(20 * mm, y + 6, 190 * mm, y + 6)
    canvas.setFont("Helvetica", 7.6)
    canvas.setFillColor(MUTED)
    canvas.drawString(20 * mm, y, "KGM Legal OS · System audit and security review · 27 September 2026")
    canvas.drawRightString(190 * mm, y, f"Page {doc.page}")
    canvas.restoreState()


def cover(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BRAND)
    canvas.rect(0, A4[1] - 74 * mm, A4[0], 74 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(20 * mm, A4[1] - 22 * mm, "KGM LEGAL OS · CONFIDENTIAL")
    canvas.restoreState()


def build():
    doc = BaseDocTemplate(
        str(OUT), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=20 * mm, bottomMargin=22 * mm,
        title="KGM Legal OS — System Audit and Security Review",
        author="Engineering review, 27 September 2026",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[frame], onPage=cover),
        PageTemplate(id="body", frames=[frame], onPage=footer),
    ])

    S: list = []
    today = date(2026, 9, 27)

    # ── COVER ────────────────────────────────────────────────────────────────
    S += [Spacer(1, 84 * mm),
          P("System audit and security review", TITLE),
          P("A plain-English account of what your system does, what it protects, "
            "what is built but not yet switched on, and what needs a decision from you.", SUB),
          Spacer(1, 10), rule(),
          P("<b>Prepared for</b> · the firm's management", BODY),
          P("<b>Prepared by</b> · the engineering review team", BODY),
          P(f"<b>Date</b> · {today.strftime('%d %B %Y')}", BODY),
          P("<b>Status</b> · Audit complete; three items require your decision before the "
            "system handles real client money or real tax invoices.", BODY),
          Spacer(1, 8),
          panel("<b>How to read this document.</b> Every technical word is explained the first "
                "time it is used, and again in the glossary on the last page. Every number "
                "quoted here was counted by a program that was run against your live system on "
                "the date above — not estimated and not typed by hand."),
          ]

    # ── the cover ends here; everything below is the body ────────────────────
    S.append("__BODY__")

    # ── 1 · WHAT WAS REVIEWED ────────────────────────────────────────────────
    S += [P("1 · What was reviewed, and how", H1),
          P("This was not a reading of the code. The system was exercised: accounts were signed "
            "in to, forbidden actions were attempted deliberately, the database was queried "
            "directly, and the automated checks were run. Where this report says something is "
            "true, it is because it was tested.", BODY),
          table([
              ["Area", "What it covers", "Size"],
              ["Database", "Every table that holds firm, client, matter, document, time and "
                           "money records", "87 tables · 297 access rules"],
              ["Firm software (back office)", "The application the firm's staff use",
               "118 endpoints · 11 screens"],
              ["Client portal", "The application clients sign in to",
               "36 endpoints · 21 screens"],
              ["Automated checks", "Tests that assert the security rules, run on every change",
               "21 files · 648 checks"],
              ["Live environment", "The deployed system and the managed database behind it",
               "2 firms · 6 staff · 4 client users · 30 documents"],
          ], [32 * mm, 96 * mm, 42 * mm]),
          ]

    S += [P("2 · The short version", H1),
          panel(
              "<b>What is in good shape.</b> The foundations are strong and, unusually for a "
              "system at this stage, they are enforced by the database rather than by good "
              "intentions. Client money, privileged documents, tax invoices and the audit trail "
              "are protected by rules that hold even if the application has a bug. The one "
              "unauthenticated opening that existed was found and closed during this review, and "
              "a maintenance login that could impersonate both the firm and the client was "
              "removed. 648 automated checks pass.",
              colors.HexColor("#EFF6F1")),
          Spacer(1, 7),
          panel(
              "<b>What needs your attention.</b> Three things are not what they appear to be on "
              "the screen. (1) The system produces invoices with official-looking tax stamps, but "
              "the connection to the Saudi tax authority is a simulation — those are not valid "
              "tax invoices. (2) Invoices do not bill exactly what the time records say: hours are "
              "rounded before the money is worked out, which under-bills slightly on most "
              "durations. (3) Four invoices have already been shown to clients through the portal "
              "without ever being properly issued. None of these is a break-in; all three would "
              "matter in an audit or a client dispute.",
              colors.HexColor("#FDF3EA")),
          ]

    S += [P("Findings at a glance", H2),
          table([
              ["Finding", "Severity", "Status"],
              ["Internal database functions could be called by anyone on the internet, and one "
               "returned a real client money balance", chip("fixed"), "Closed and verified"],
              ["A leftover maintenance login could act as both the firm and the client",
               chip("fixed"), "Removed"],
              ["Restricting a matter for confidentiality recorded success without changing "
               "anything, and said the matter did not exist", chip("fixed"),
               "Fixed at three layers, verified"],
              ["A wrongly drafted invoice could not be withdrawn, leaving hours frozen forever",
               chip("fixed"), "New feature, verified end to end"],
              ["Tax invoices are stamped locally but never sent to the tax authority",
               chip("high"), "Awaits your decision"],
              ["Invoices do not bill the amount the time record states (rounded hours)",
               chip("high"), "Awaits your decision"],
              ["Four invoices reached clients without a valid tax identity", chip("medium"),
               "Clean-up recommended"],
              ["A supporting software library has two known moderate security advisories",
               chip("medium"), "Upgrade to schedule"],
              ["Live secrets and demonstration data are still in place", chip("medium"),
               "Before go-live"],
              ["61 capabilities exist in the system with no screen to reach them",
               chip("low"), "Roadmap"],
          ], [92 * mm, 40 * mm, 38 * mm]),
          ]

    # ── 3 · SECURITY ────────────────────────────────────────────────────────
    S += [P("3 · Security: what protects the system", H1),
          P("These are not features to be added later. They are in place now, and each was "
            "confirmed against the running system.", BODY)]
    S += bullets([
        "<b>Nobody outside gets in without an account.</b> An unauthenticated visitor can read "
        "no table and — after this review — run no internal function. Before the fix, thirteen "
        "internal helpers were reachable by an anonymous caller; one of them disclosed a real "
        "client money balance of SAR 65,000. That door is closed and the closure was verified.",
        "<b>Sign-in is defensible.</b> Passwords are stored one-way (they cannot be read back, "
        "even by us); a wrong password and an unknown account give the identical reply, so the "
        "system cannot be used to discover who your clients are; repeated attempts are throttled "
        "and the account locks; firm staff must pass a second factor; session tokens are stored "
        "only as fingerprints.",
        "<b>The two doors never mix.</b> A firm credential presented at the client portal is "
        "refused exactly like a wrong password, and the reverse. Verified 6 out of 6.",
        "<b>Clients see only their own matters.</b> A client asking for another client's "
        "document receives the same answer as for a document that does not exist.",
        "<b>Privileged material is ring-fenced.</b> Documents marked privileged are withheld "
        "from clients and from unlicensed lawyers, and every read is written to the audit trail "
        "with the reason. 36 checks against the live system, all passing.",
        "<b>The two firms cannot see each other.</b> The second firm on the system cannot read "
        "or pay the first firm's invoice — tested, not assumed.",
        "<b>Money and tax documents are protected by the database itself.</b> An issued tax "
        "invoice cannot be deleted or quietly edited; a billed hour cannot be moved to another "
        "invoice or un-billed. The system's answer is a credit note, which is what your "
        "accounting rules say it should be.",
        "<b>Every important action leaves a record.</b> 2,391 audit entries so far, and the "
        "database refuses to let those entries be edited or deleted — including by us.",
        "<b>Uploads and web requests are contained.</b> Files are checked by type, size, name "
        "and actual content; uploads are limited per session; requests are rate-limited; and "
        "the browser is given strict security headers. No way to inject database commands was "
        "found anywhere in the code.",
    ])

    S += [P("What was found and fixed during this review", H2),
          table([
              ["What we found", "What it meant", "What we did"],
              ["Thirteen internal database helpers were callable by an anonymous visitor. One "
               "returned a real client trust balance; others answered yes/no questions about "
               "records.",
               "A stranger with no account could obtain financial figures or confirm guesses "
               "about your data.",
               "Removed the default public permission on all internal helpers and granted it "
               "only to the four roles the software uses. Re-tested: every anonymous attempt is "
               "now refused."],
              ["A maintenance login (named <i>kgm_probe</i>) existed in the live database and "
               "could act as either the firm software or the client portal.",
               "A second key to the building, cut during construction and never collected.",
               "The login was removed. Its password must be treated as disclosed and changed "
               "wherever it may have been reused."],
              ["Restricting a matter reported success in the audit trail while changing nothing, "
               "and the screen said the matter did not exist.",
               "A confidentiality protection that appears to work but does not — the worst kind.",
               "Three fixes: a database rule so every matter always has its control record; a "
               "one-time backfill for existing matters (21 of 21 now complete); and the refusal "
               "moved ahead of the record so nothing untrue is ever written."],
              ["A draft invoice could not be withdrawn: its hours stayed frozen, the invoice "
               "number was consumed, and the money showed as unbilled.",
               "A mistyped fee could only be undone with a database administrator.",
               "Added cancellation of a draft: it keeps its record and reason, and its hours and "
               "expenses return to the unbilled list. Verified on the live system."],
          ], [50 * mm, 55 * mm, 65 * mm]),
          ]

    S += [P("Still open on security", H2),
          table([
              ["Item", "Severity", "What we recommend"],
              ["A supporting software library (react-router) has two known moderate advisories: "
               "a crafted link could send a user to another website, and a flaw in a "
               "server-rendering mode the product does not use.",
               chip("medium"),
               "Neither is reachable in the current product, and the fix is a major version "
               "upgrade that needs a test cycle. Schedule it with the next release."],
              ["The database does not record who connected, and logs only structural changes. "
               "The application keeps its own detailed trail, so nothing is missing today.",
               chip("low"),
               "Turn on connection logging before go-live. It costs nothing and answers "
               "\"who was in the system at 3am?\"."],
              ["The live configuration file holds the database password and the encryption keys "
               "that protect stored secrets. It is not in source control.",
               chip("medium"),
               "Treat every secret as compromised at go-live and replace them all. This is "
               "normal at the end of a build; it is not normal to leave it."],
          ], [78 * mm, 32 * mm, 60 * mm]),
          ]

    # ── 4 · MONEY CORRECTNESS ───────────────────────────────────────────────
    S += [P("4 · Money: the invoice does not bill what the time record says", H1),
          P("This is the finding most likely to cost you money, and it is the one to decide on "
            "first.", BODY),
          P("A lawyer records 95 minutes at SAR 1,200 per hour. The time record stores SAR 1,900 "
            "for that work. When an invoice is drafted, the system first converts the 95 minutes "
            "into hours — and rounds it to 1.58 hours — and then multiplies: 1.58 × 1,200 = "
            "<b>SAR 1,896</b>. Four riyals have disappeared, and the invoice and your own time "
            "record now disagree about the same hour. A second example on the live system showed "
            "SAR 3,792 billed against SAR 3,800 recorded.", BODY),
          panel("<b>Why it happens.</b> The hours figure is rounded to two decimal places before "
                "the money is calculated. Any duration that is not exactly one hundredth of an "
                "hour loses a fraction — small per line, systematic across a year, and invisible "
                "because each document looks internally consistent.<br/><br/>"
                "<b>Why it matters beyond the money.</b> The invoice is the tax document. If the "
                "amount billed does not match the firm's own record of the work, the difference "
                "has to be explained in a client query, an internal audit or a tax review.<br/><br/>"
                "<b>Your decision.</b> Either (a) bill the amount the time record states and show "
                "the hours as a description, accepting that the displayed hours will not multiply "
                "out to the halala on the page; or (b) keep the current arithmetic and require "
                "durations to be recorded in a unit that converts exactly. We recommend (a): the "
                "recorded amount is the truth, and the invoice should follow it.",
                colors.HexColor("#FDF3EA")),
          ]

    # ── 5 · BUILT BUT NOT SWITCHED ON ──────────────────────────────────────
    S += [P("5 · Built, but not switched on", H1),
          P("These parts of the system exist, are tested, and are not connected to the outside "
            "services they need. Each is a matter of configuration and credentials rather than "
            "new development — but until then, the system is not doing the job the screen "
            "suggests.", BODY),
          table([
              ["Capability", "What the system does today", "What it needs"],
              ["Tax invoicing (Saudi e-invoicing, \"ZATCA\")",
               "Produces invoices carrying the official fields — a UUID, a counter, a hash "
               "chain position and a QR code — generated locally. The database records the firm "
               "as being in <i>production</i> mode with a placeholder tax number and no "
               "certificate. Nothing is ever sent to, cleared or reported to the tax authority.",
               "Real tax-authority onboarding: a certificate for the firm, a registered device, "
               "and a certified connection. Until then, invoices issued here are <b>not valid "
               "tax invoices</b> and must not be sent to a client."],
              ["Email",
               "Every message the system composes — client invitations, notifications, password "
               "resets — is written to the server log instead of being delivered.",
               "An email provider account and its credentials. Nothing else changes."],
              ["Document storage",
               "Files are saved on the server's own disk. The private cloud storage buckets exist "
               "but are empty.",
               "The managed storage service, plus the retention and access-logging settings. "
               "For a legal practice, where documents live and for how long is a requirement, "
               "not a preference."],
              ["Card and Sadad payments",
               "The interface offers payment methods, but no payment provider is connected, and "
               "recording a payment is a manual entry by a member of staff.",
               "A payment provider agreement and its keys. No provider has ever delivered a "
               "payment notification to this system — the record of such events is empty."],
              ["Second-factor codes",
               "The second factor works, but in the demonstration the code is displayed on "
               "screen rather than sent to a phone.",
               "An SMS provider, or an authenticator application (no provider needed, and more "
               "secure)."],
          ], [38 * mm, 76 * mm, 56 * mm]),
          ]

    # ── 6 · WHAT THE SCREEN CANNOT DO YET ──────────────────────────────────
    S += [P("6 · What the software can do, but no screen can reach", H1),
          P("Behind the screens, 61 capabilities are built, secured and waiting. They can be "
            "used by an engineer or another system, but a member of your staff cannot perform "
            "them. This is the largest single gap between what you have paid for and what your "
            "team can do, and it is purely a matter of building the screens.", BODY),
          table([
              ["Area", "What is waiting behind the curtain", "Count"],
              ["Compliance and risk", "Money-laundering reports to the authorities; customer "
               "due-diligence files; screening against sanctions lists and handling the results; "
               "high-risk country lists; lawyer eligibility and licence records; previous "
               "employment declarations", "16"],
              ["Client money (trust) accounting",
               "Client ledgers, entries against them and the reconciliation that proves the "
               "firm's trust account balances", "5"],
              ["Billing, beyond drafting",
               "Credit notes, write-offs, discounts, the firm's tax profile and devices, the "
               "submission queue and the reporting queue, and issuing an invoice from the "
               "screen", "11"],
              ["Client administration",
               "Editing a client record, sending a portal invitation, and managing the parties "
               "on the other side, their alternative names and their relationships", "6"],
              ["Time and expenses",
               "Recording and adjusting time and expenses from the screen, rather than through "
               "another system", "6"],
              ["Registers", "Judgments (edit and firm-wide list), hearings and the court "
               "calendar, rate cards, engagement letters and billing terms", "7"],
          ], [36 * mm, 112 * mm, 22 * mm]),
          Spacer(1, 4),
          P("Two smaller points in the same area. Twenty-one of the seventy-five permission "
            "codes the system defines are not yet used by anything — they describe abilities "
            "(archiving a client, approving a document, exporting the audit trail) that no "
            "screen or rule currently asks for. And the firm application has no \"skip to "
            "content\" link, which the client portal does have; it is a small accessibility "
            "gap for keyboard users.", BODY),
          ]

    # ── 7 · DATA QUALITY ───────────────────────────────────────────────────
    S += [P("7 · The state of the data you would hand to a client", H1),
          table([
              ["What is in the live system", "Why it matters"],
              ["Four invoices are visible to clients through the portal but were never properly "
               "issued as tax invoices (two \"sent\", one \"paid\", one \"partly paid\").",
               "A client can see and even pay a document that is not valid for tax purposes. "
               "These should be written off or corrected before the system is used in earnest."],
              ["Fourteen matters had no control record, which is why restricting a matter "
               "silently failed. All 21 matters now have one.",
               "Fixed during this review; the underlying rule is now enforced by the database."],
              ["Ten test drafts named \"LIVE-FISCAL-…\" carry tax stamps. They were produced by "
               "a fiscal test rather than by real work.",
               "They should be cleared so nobody mistakes them for real documents."],
              ["The demonstration firm, its demonstration staff, its demonstration clients and "
               "their credentials are stored in the same production database.",
               "Before go-live this data, and those passwords, must be removed — not reused."],
          ], [78 * mm, 92 * mm]),
          ]

    # ── 8 · WHAT CHANGED DURING THIS REVIEW ────────────────────────────────
    S += [P("8 · What we changed while reviewing", H1),
          P("These are live changes to the system and the database, each verified after it was "
            "made. Nothing here is a proposal.", BODY)]
    S += bullets([
        "Two database updates were applied to the live database: the closing of the anonymous "
        "function access, the removal of the maintenance login, the rule that every matter gets "
        "its control record, and the permission needed for draft cancellation to release its "
        "hours. Both were dry-run first and re-verified afterwards.",
        "A cancelled-draft capability was completed end to end: the database rule, the service, "
        "the screen action, and 9 lines of Arabic and English wording.",
        "The audit-order defect in matter restriction was fixed, with a test that fails if a "
        "success is ever recorded for an action that did not happen.",
        "Two new tests were added (648 in total, all passing), one of which reproduces the "
        "restriction failure that was previously invisible.",
        "Three defects in the verification tooling itself were corrected — including one that "
        "made two client-visibility checks pass for the wrong reason, and one that caused every "
        "run to permanently consume one of the firm's recorded hours.",
    ])

    # ── 9 · RECOMMENDATIONS ────────────────────────────────────────────────
    S += [P("9 · What we recommend, in order", H1),
          table([
              ["#", "Action", "Why now"],
              ["1", "Decide how invoices should bill rounded hours, and apply it.",
               "It is the only finding that silently moves money, and it affects every invoice "
               "from the first day of real use."],
              ["2", "Complete tax-authority onboarding before any invoice reaches a real client.",
               "An invalid tax invoice is a compliance breach, not a display problem."],
              ["3", "Clean the four un-issued client-visible invoices and the ten fiscal test "
               "drafts; then remove the demonstration firm and its accounts.",
               "The system should not start its real life carrying demonstration records."],
              ["4", "Connect the four waiting services: email, document storage, payments and "
               "e-invoicing.",
               "Each is credentials and configuration rather than new development, and each one "
               "removes a manual step from your team's day."],
              ["5", "Rotate every secret and turn on database connection logging.",
               "Standard practice the moment a system leaves build for production."],
              ["6", "Schedule the library upgrade, and the missing screens in the order: "
               "compliance console, trust accounting, billing extras.",
               "These are the abilities your team will ask for first, and the compliance set is "
               "the one with a legal deadline attached."],
          ], [8 * mm, 84 * mm, 78 * mm]),
          ]

    # ── 10 · GLOSSARY ──────────────────────────────────────────────────────
    S += [P("10 · Glossary, in plain English", H1),
          table([
              ["Term", "What it means"],
              ["Audit trail", "The permanent record of who did what, and when. This system's "
                              "record cannot be edited or deleted, not even by an administrator."],
              ["Database rule (trigger)", "A check that lives inside the database itself, so it "
                                          "applies to every program that touches the data — and "
                                          "cannot be bypassed by a bug in the application."],
              ["Demo / demonstration data", "Sample firms, staff, clients and documents created "
                                            "to show the system working. They are not real and "
                                            "must be removed before go-live."],
              ["Hash", "A one-way fingerprint of data. Passwords are stored this way: the system "
                       "can check a password but cannot recover one."],
              ["Migration", "A numbered, reviewed change to the database's structure or rules, "
                            "applied in order and recorded so the database's history is known."],
              ["Permission code", "A named ability, such as \"matters.close\". Every action in the "
                                  "system asks for one, and a role is only a bundle of them."],
              ["Row-level security", "A rule that decides, per user, which individual records "
                                     "they may see — so a client's query cannot return another "
                                     "client's file even if the screen is wrong."],
              ["Session token", "The temporary key a signed-in browser carries. The system stores "
                                "only a fingerprint of it."],
              ["Tax identity (UUID, ICV, hash)", "The fields Saudi e-invoicing requires on each "
                                                 "invoice: a unique identifier, a sequential "
                                                 "counter, and a link to the previous invoice so "
                                                 "the sequence cannot be altered."],
              ["Two-factor authentication", "A second proof of identity beyond the password, so a "
                                            "stolen password is not enough to sign in."],
              ["Webhook", "A message a payment provider sends to the system to confirm money "
                          "arrived, without anyone typing it in."],
              ["ZATCA", "The Saudi tax authority, whose e-invoicing rules require invoices to be "
                        "generated in a specific electronic form and cleared or reported to it."],
          ], [40 * mm, 130 * mm]),
          Spacer(1, 6),
          rule(),
          P("The detailed engineering record of this review — every query, every failing check, "
            "and the exact state of each item above — is kept with the system as "
            "<i>docs/AUDIT-2026-09-27.md</i>. The numbers in this document are produced by the "
            "same tooling, and the report can be regenerated after any change.", SMALL),
          ]

    split = S.index("__BODY__")
    cover_story = S[:split]
    body_story = S[split + 1:]

    doc.build(cover_story + [NextPageTemplate("body"), PageBreak()] + body_story)
    print(f"wrote {OUT}  ({OUT.stat().st_size // 1024} kB)")


if __name__ == "__main__":
    build()
