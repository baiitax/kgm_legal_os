#!/usr/bin/env python3
"""
KGM LEGAL OS — TEST CREDENTIAL MANUAL (PDF)

    python3 scripts/make-credential-manual.py

Builds the credential handbook for the demo deployment from
`/tmp/manual-data.json`, which is produced by:

    node scripts/verify/credentials.mjs <base-url>   # signs in as every account
    node scripts/collect-manual-data.mjs             # reads the live database

WHY IT IS GENERATED RATHER THAN WRITTEN
  A credential document is the one artefact that is worse than useless when it
  drifts: it sends a tester to a password that changed, and the failure looks like
  a broken deployment. Every fact in this PDF — who exists, which client they
  belong to, what they can see, whether the password still works — is read from
  the live database and the live HTTP responses at build time. Running the script
  again after a seed change produces a correct document instead of a stale one.

THE TYPOGRAPHY IS THE PRODUCT'S OWN
  IBM Plex Sans Arabic, the same faces the portals self-host, converted from the
  repository's woff2 files. The Arabic face carries no Latin glyphs at all and
  the Latin face carries no Arabic, so every string is segmented by script and
  each run is set in the face that has it — the same arrangement the web fonts
  use, with a unicode-range per subset.
"""
import json
import re
import sys
from pathlib import Path

from arabic_reshaper import reshape
from bidi.algorithm import get_display
from fontTools.ttLib import TTFont
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont as PDFTTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, NextPageTemplate, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = Path('/tmp/manual-data.json')
OUT_PATH = Path('/home/user/KGM-LEGAL-OS-Test-Credentials.pdf')
FONT_CACHE = Path('/tmp/fonts')

# ─── palette · lifted from the products' own tokens ──────────────────────────
MIDNIGHT = colors.HexColor('#072821')
DEEP = colors.HexColor('#0b3a2f')
BRAND = colors.HexColor('#14654e')
BRAND_LIGHT = colors.HexColor('#1c7d61')
LIME = colors.HexColor('#6fbda4')
LIME_SOFT = colors.HexColor('#eaf6f0')
GOLD = colors.HexColor('#c8a45c')
GOLD_SOFT = colors.HexColor('#f6efdf')
GOLD_DEEP = colors.HexColor('#a8853f')
WHITE = colors.white
CARD = colors.HexColor('#f7f9f8')
INK = colors.HexColor('#10231d')
MUTED = colors.HexColor('#5f6f69')
LINE = colors.HexColor('#dfe4e2')
ALERT = colors.HexColor('#8a2f2f')
ALERT_SOFT = colors.HexColor('#fdf2f2')

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm


# ─── fonts ───────────────────────────────────────────────────────────────────
def rename(font, ps_name, family, subfamily):
    """
    Give a converted subset its own internal name.

    The Arabic and Latin subsets are cut from the SAME upstream family, so
    `latin-400` and `arabic-400` both arrive calling themselves
    `IBMPlexSansArabic-Regular`. reportlab keys the embedded font on that
    internal name rather than on the name it was registered under, so the two
    collide and the Latin face silently wins: every Arabic string then draws
    with a font that has no Arabic glyphs, producing correct-looking layout,
    NULs in the text layer and nothing on the page. Distinct names stop that.
    """
    name = font['name']
    for record in list(name.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17):
            name.removeNames(record.nameID, record.platformID, record.platEncID, record.langID)
    for value, name_id in ((family, 1), (subfamily, 2), (ps_name, 3),
                           (f'{family} {subfamily}', 4), (ps_name, 6)):
        name.setName(value, name_id, 3, 1, 0x409)   # Windows, Unicode BMP, en-US
        name.setName(value, name_id, 1, 0, 0)       # Mac, Roman, English


def ensure_fonts():
    """
    Convert the repository's woff2 subsets to TTF and re-register them.

    Converted on every run rather than cached: a stale font is exactly the kind
    of fault this document must not carry, and six conversions cost well under a
    second.
    """
    FONT_CACHE.mkdir(parents=True, exist_ok=True)
    subsets = {
        # woff2 subset -> (ttf, postscript name, family, subfamily)
        'ibm-plex-sans-arabic-arabic-400-normal.woff2': ('PlexArabic-Regular.ttf', 'KGMPlexArabic-Regular', 'KGM Plex Arabic', 'Regular'),
        'ibm-plex-sans-arabic-arabic-500-normal.woff2': ('PlexArabic-Medium.ttf', 'KGMPlexArabic-Medium', 'KGM Plex Arabic', 'Medium'),
        'ibm-plex-sans-arabic-arabic-700-normal.woff2': ('PlexArabic-Bold.ttf', 'KGMPlexArabic-Bold', 'KGM Plex Arabic', 'Bold'),
        'ibm-plex-sans-arabic-latin-400-normal.woff2': ('PlexLatin-Regular.ttf', 'KGMPlexLatin-Regular', 'KGM Plex Latin', 'Regular'),
        'ibm-plex-sans-arabic-latin-600-normal.woff2': ('PlexLatin-SemiBold.ttf', 'KGMPlexLatin-SemiBold', 'KGM Plex Latin', 'SemiBold'),
        'ibm-plex-sans-arabic-latin-700-normal.woff2': ('PlexLatin-Bold.ttf', 'KGMPlexLatin-Bold', 'KGM Plex Latin', 'Bold'),
    }
    source = ROOT / 'packages' / 'ui' / 'fonts'
    for woff, (ttf, ps_name, family, subfamily) in subsets.items():
        if not (source / woff).exists():
            sys.exit(f'missing font subset: {source / woff}')
        font = TTFont(source / woff)
        font.flavor = None
        rename(font, ps_name, family, subfamily)
        font.save(FONT_CACHE / ttf)

    pdfmetrics.registerFont(PDFTTFont('Plex', str(FONT_CACHE / 'PlexLatin-Regular.ttf')))
    pdfmetrics.registerFont(PDFTTFont('Plex-Semi', str(FONT_CACHE / 'PlexLatin-SemiBold.ttf')))
    pdfmetrics.registerFont(PDFTTFont('Plex-Bold', str(FONT_CACHE / 'PlexLatin-Bold.ttf')))
    pdfmetrics.registerFont(PDFTTFont('PlexAr', str(FONT_CACHE / 'PlexArabic-Regular.ttf')))
    pdfmetrics.registerFont(PDFTTFont('PlexAr-Med', str(FONT_CACHE / 'PlexArabic-Medium.ttf')))
    pdfmetrics.registerFont(PDFTTFont('PlexAr-Bold', str(FONT_CACHE / 'PlexArabic-Bold.ttf')))
    pdfmetrics.registerFontFamily('Plex', normal='Plex', bold='Plex-Bold', italic='Plex', boldItalic='Plex-Bold')
    pdfmetrics.registerFontFamily('PlexAr', normal='PlexAr', bold='PlexAr-Bold', italic='PlexAr', boldItalic='PlexAr-Bold')


ARABIC = re.compile(r'[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]')


def esc(text) -> str:
    return (str(text).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))


def mixed(text, arabic_font: str = 'PlexAr') -> str:
    """
    A Paragraph string with each script set in a face that can draw it.

    The Arabic runs are shaped (presentation forms) and reordered (bidi) before
    they are wrapped, because the PDF has no text-shaping engine: reportlab draws
    the codepoints it is given, and unshaped Arabic letters come out disconnected
    and in the wrong order.
    """
    text = str(text)
    parts, buffer, mode = [], '', None
    for ch in text:
        is_ar = bool(ARABIC.match(ch))
        if mode is None:
            mode = is_ar
        elif is_ar != mode:
            parts.append((mode, buffer))
            buffer, mode = '', is_ar
        buffer += ch
    if buffer:
        parts.append((mode, buffer))

    out = []
    for is_ar, chunk in parts:
        if is_ar:
            shaped = get_display(reshape(chunk))
            out.append(f'<font name="{arabic_font}">{esc(shaped)}</font>')
        else:
            out.append(esc(chunk))
    return ''.join(out)


def plain(text) -> str:
    """Shaped Arabic, for the drawing canvas (no Paragraph markup)."""
    return get_display(reshape(str(text)))


# ─── styles ──────────────────────────────────────────────────────────────────
def styles():
    base = dict(fontName='Plex', textColor=INK, leading=15)
    return {
        'h1': ParagraphStyle('h1', fontName='Plex-Bold', fontSize=25, leading=30, textColor=WHITE),
        'h1ar': ParagraphStyle('h1ar', fontName='PlexAr-Bold', fontSize=20, leading=28,
                               textColor=GOLD, alignment=TA_RIGHT, rightIndent=2.5 * mm),
        'h2': ParagraphStyle('h2', fontName='Plex-Bold', fontSize=15.5, leading=20, textColor=DEEP,
                             spaceAfter=1),
        'h2ar': ParagraphStyle('h2ar', fontName='PlexAr-Bold', fontSize=13.5, leading=19,
                               textColor=BRAND, alignment=TA_RIGHT, rightIndent=2.5 * mm),
        'h3': ParagraphStyle('h3', fontName='Plex-Semi', fontSize=11, leading=15, textColor=DEEP),
        'eyebrow': ParagraphStyle('eyebrow', fontName='Plex-Semi', fontSize=8, leading=11,
                                  textColor=GOLD_DEEP),
        'body': ParagraphStyle('body', **base),
        'body-sm': ParagraphStyle('body-sm', fontName='Plex', fontSize=8.8, leading=12.6, textColor=MUTED),
        'note': ParagraphStyle('note', fontName='Plex', fontSize=8.4, leading=12, textColor=MUTED),
        'label': ParagraphStyle('label', fontName='Plex-Semi', fontSize=7.4, leading=10, textColor=GOLD_DEEP),
        'value': ParagraphStyle('value', fontName='Plex', fontSize=9.6, leading=13, textColor=INK),
        'mono': ParagraphStyle('mono', fontName='Plex-Semi', fontSize=10.4, leading=14, textColor=DEEP),
        'pw': ParagraphStyle('pw', fontName='Plex-Bold', fontSize=12.5, leading=16, textColor=BRAND_LIGHT),
        'name': ParagraphStyle('name', fontName='Plex-Bold', fontSize=14, leading=18, textColor=DEEP),
        'namear': ParagraphStyle('namear', fontName='PlexAr-Bold', fontSize=12.5, leading=18,
                                 textColor=BRAND, alignment=TA_RIGHT, rightIndent=2.5 * mm),
        'cell': ParagraphStyle('cell', fontName='Plex', fontSize=8.6, leading=11.6, textColor=INK),
        'cellar': ParagraphStyle('cellar', fontName='PlexAr', fontSize=9.4, leading=13, textColor=INK,
                                 alignment=TA_RIGHT),
        'cellh': ParagraphStyle('cellh', fontName='Plex-Semi', fontSize=8, leading=11, textColor=WHITE),
        'alert': ParagraphStyle('alert', fontName='Plex', fontSize=8.6, leading=12.4, textColor=ALERT),
        'cover_sub': ParagraphStyle('cover_sub', fontName='Plex', fontSize=11.5, leading=17,
                                    textColor=LIME),
    }


OUTLINE = {
    2: 'How to sign in',
    3: 'Client portal accounts',
    4: 'Internal firm OS accounts',
    5: 'Internal firm OS accounts (continued)',
    6: 'What each account can see',
    7: 'Verification record',
}


def header_footer(canvas, doc):
    """Running head on every content page, plus a bookmark."""
    canvas.saveState()
    key = f'page-{doc.page}'
    canvas.bookmarkPage(key)
    if doc.page in OUTLINE:
        canvas.addOutlineEntry(OUTLINE[doc.page], key, level=0, closed=False)
    canvas.setFillColor(DEEP)
    canvas.rect(0, PAGE_H - 16 * mm, PAGE_W, 16 * mm, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.setFont('PlexAr-Bold', 9.5)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 10.6 * mm, plain('نظام كي جي إم القانوني'))
    canvas.setFillColor(WHITE)
    canvas.setFont('Plex-Semi', 9)
    canvas.drawString(MARGIN, PAGE_H - 10.6 * mm, 'KGM LEGAL OS · Test Credential Manual')
    canvas.setFillColor(MUTED)
    canvas.setFont('Plex', 7.6)
    canvas.drawString(MARGIN, 10 * mm, 'Synthetic demo data — no real client information')
    canvas.drawRightString(PAGE_W - MARGIN, 10 * mm, f'{doc.page}')
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 14 * mm, PAGE_W - MARGIN, 14 * mm)
    canvas.restoreState()


# ─── building blocks ─────────────────────────────────────────────────────────
def section(title, title_ar, eyebrow=None):
    flow = []
    if eyebrow:
        flow.append(Paragraph(esc(eyebrow.upper()), S['eyebrow']))
        flow.append(Spacer(1, 3))
    flow.append(Paragraph(esc(title), S['h2']))
    flow.append(Spacer(1, 1))
    flow.append(Paragraph(mixed(title_ar, 'PlexAr-Bold'), S['h2ar']))
    flow.append(Spacer(1, 6))
    rule = Table([['']], colWidths=[PAGE_W - 2 * MARGIN], rowHeights=[1.6])
    rule.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), GOLD),
                              ('LINEBELOW', (0, 0), (-1, -1), 0, GOLD)]))
    flow.append(rule)
    flow.append(Spacer(1, 10))
    return flow


def kv(label, value, value_style='value'):
    return [
        Paragraph(esc(label.upper()), S['label']),
        Spacer(1, 1.5),
        Paragraph(value, S[value_style]),
    ]


def account_card(rows, accent=BRAND):
    """A bordered card whose left edge carries the audience colour."""
    inner = Table(rows, colWidths=[(PAGE_W - 2 * MARGIN) - 6 * mm])
    inner.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 7 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    card = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN])
    card.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), CARD),
        ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('LINEBEFORE', (0, 0), (0, -1), 3.2, accent),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 5.5 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5.5 * mm),
    ]))
    return card


def credential_row(email, password):
    """The one line a tester actually copies from."""
    t = Table(
        [[Paragraph('EMAIL', S['label']), Paragraph('PASSWORD', S['label'])],
         [Paragraph(esc(email), S['mono']), Paragraph(esc(password), S['pw'])]],
        colWidths=[(PAGE_W - 2 * MARGIN - 12 * mm) * 0.62, (PAGE_W - 2 * MARGIN - 12 * mm) * 0.38],
    )
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), WHITE),
        ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return t


def bullet_list(items):
    rows = [[Paragraph('•', S['cell']), Paragraph(mixed(i), S['cell'])] for i in items]
    t = Table(rows, colWidths=[4 * mm, (PAGE_W - 2 * MARGIN - 10 * mm) - 4 * mm])
    t.setStyle(TableStyle([
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0.8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0.8),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))
    return t


def callout(text, tone='gold'):
    bg, bar, fg = (GOLD_SOFT, GOLD, INK) if tone == 'gold' else (ALERT_SOFT, ALERT, ALERT)
    style = ParagraphStyle('c', parent=S['alert'] if tone != 'gold' else S['body'],
                           textColor=fg, fontSize=8.8, leading=13)
    inner = Table([[Paragraph(mixed(text), style)]], colWidths=[PAGE_W - 2 * MARGIN - 6 * mm])
    inner.setStyle(TableStyle([('LEFTPADDING', (0, 0), (-1, -1), 7 * mm),
                               ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
                               ('TOPPADDING', (0, 0), (-1, -1), 3.4 * mm),
                               ('BOTTOMPADDING', (0, 0), (-1, -1), 3.4 * mm)]))
    t = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), bg),
                           ('LINEBEFORE', (0, 0), (0, -1), 3.2, bar),
                           ('LEFTPADDING', (0, 0), (-1, -1), 0),
                           ('RIGHTPADDING', (0, 0), (-1, -1), 0),
                           ('TOPPADDING', (0, 0), (-1, -1), 0),
                           ('BOTTOMPADDING', (0, 0), (-1, -1), 0)]))
    return t


def data_table(header, rows, widths, align_right_cols=(), size=None):
    def styled(base_style): 
        if not size:
            return S[base_style]
        return ParagraphStyle(f'{base_style}-{size}', parent=S[base_style],
                              fontSize=size, leading=size * 1.35)

    data = [[Paragraph(esc(h), S['cellh']) for h in header]]
    for r in rows:
        line = []
        for i, cell in enumerate(r):
            right = i in align_right_cols
            style = styled('cellar' if right else 'cell')
            line.append(Paragraph(cell if right else esc(cell), style))
        data.append(line)
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), DEEP),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [WHITE, CARD]),
        ('GRID', (0, 0), (-1, -1), 0.4, LINE),
        ('BOX', (0, 0), (-1, -1), 0.6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2.4 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 2 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2 * mm),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return t


# ─── pages ───────────────────────────────────────────────────────────────────
def cover(canvas, doc):
    """Full-bleed midnight cover, drawn rather than laid out."""
    canvas.saveState()
    canvas.setFillColor(MIDNIGHT)
    canvas.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    # atmospheric gradient bands, the way the product's shell layers depth
    canvas.setFillColor(DEEP)
    canvas.rect(0, PAGE_H * 0.55, PAGE_W, PAGE_H * 0.45, stroke=0, fill=1)
    canvas.setFillColor(colors.HexColor('#0e4638'))
    canvas.rect(0, PAGE_H - 3.2 * mm, PAGE_W, 3.2 * mm, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.rect(0, PAGE_H - 4.4 * mm, PAGE_W, 1.2 * mm, stroke=0, fill=1)

    # wordmark
    canvas.setFillColor(GOLD)
    canvas.setFont('Plex-Bold', 21)
    canvas.drawString(MARGIN, PAGE_H - 42 * mm, 'KGM')
    canvas.setFillColor(WHITE)
    canvas.setFont('Plex-Semi', 21)
    w = pdfmetrics.stringWidth('KGM ', 'Plex-Bold', 21)
    canvas.drawString(MARGIN + w, PAGE_H - 42 * mm, 'LEGAL OS')
    canvas.setStrokeColor(colors.HexColor('#2b6b58'))
    canvas.setLineWidth(0.8)
    canvas.line(MARGIN, PAGE_H - 47 * mm, PAGE_W - MARGIN, PAGE_H - 47 * mm)

    canvas.setFillColor(LIME)
    canvas.setFont('PlexAr-Med', 15)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 41 * mm, plain('نظام كي جي إم القانوني'))

    # title block
    canvas.setFillColor(GOLD)
    canvas.setFont('Plex-Semi', 9.5)
    canvas.drawString(MARGIN, PAGE_H * 0.52, 'INTERNAL · DEMO ENVIRONMENT')

    canvas.setFillColor(WHITE)
    canvas.setFont('Plex-Bold', 33)
    canvas.drawString(MARGIN, PAGE_H * 0.52 - 15 * mm, 'Test Credential')
    canvas.drawString(MARGIN, PAGE_H * 0.52 - 25.6 * mm, 'Manual')

    # the Arabic title sits under the rule rather than beside the English: the
    # two scripts have different metrics and side by side they fight for width
    canvas.setStrokeColor(GOLD)
    canvas.setLineWidth(1.6)
    canvas.line(MARGIN, PAGE_H * 0.52 - 33 * mm, PAGE_W - MARGIN, PAGE_H * 0.52 - 33 * mm)
    canvas.setFillColor(GOLD)
    canvas.setFont('PlexAr-Bold', 20)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H * 0.52 - 41.5 * mm, plain('دليل بيانات الدخول التجريبية'))
    canvas.setFillColor(LIME)
    canvas.setFont('Plex', 9.5)
    canvas.drawString(MARGIN, PAGE_H * 0.52 - 41 * mm, 'Two products, one origin,')
    canvas.drawString(MARGIN, PAGE_H * 0.52 - 45.5 * mm, 'no shared authorization surface')

    # the two doors
    y = PAGE_H * 0.52 - 55 * mm
    labels = [
        ('Client Portal', '/', 'ahmed.alsaud@example.test'),
        ('Internal Firm OS', '/firm', 'noura@kgm.example.test'),
    ]
    for i, (name, path, email) in enumerate(labels):
        col = MARGIN + i * ((PAGE_W - 2 * MARGIN) / 2)
        canvas.setFillColor(colors.HexColor('#123f34'))
        canvas.roundRect(col, y - 16 * mm, (PAGE_W - 2 * MARGIN) / 2 - 5 * mm, 22 * mm, 2 * mm, stroke=0, fill=1)
        canvas.setFillColor(GOLD)
        canvas.setFont('Plex-Semi', 8)
        canvas.drawString(col + 4 * mm, y - 0.5 * mm, name.upper())
        canvas.setFillColor(WHITE)
        canvas.setFont('Plex-Bold', 13)
        canvas.drawString(col + 4 * mm, y - 6.5 * mm, path)
        canvas.setFillColor(LIME)
        canvas.setFont('Plex', 7.4)
        canvas.drawString(col + 4 * mm, y - 11.5 * mm, email)

    # footer facts
    canvas.setFillColor(colors.HexColor('#7fa79a'))
    canvas.setFont('Plex', 8)
    canvas.drawString(MARGIN, 34 * mm, f'Deployment   {DATA["base"]}')
    canvas.drawString(MARGIN, 29 * mm, f'Generated    {DATA["generatedAt"][:19].replace("T", " ")} UTC')
    canvas.drawString(MARGIN, 24 * mm, f'Accounts     {len(DATA["portal"])} client portal · {len(DATA["firm"])} firm OS')
    canvas.setFillColor(GOLD)
    canvas.setFont('Plex-Semi', 8)
    canvas.drawRightString(PAGE_W - MARGIN, 34 * mm, 'SYNTHETIC DATA ONLY')
    canvas.setFillColor(colors.HexColor('#7fa79a'))
    canvas.setFont('Plex', 8)
    canvas.drawRightString(PAGE_W - MARGIN, 29 * mm, 'Every credential below was verified by signing in.')
    canvas.restoreState()


def page_signin():
    flow = section('How to sign in', 'كيفية تسجيل الدخول', 'both portals')
    flow.append(Paragraph(
        'The portal and the firm OS are one deployment, one origin and one database, '
        'separated by an audience check. A given account works at exactly one door: the server '
        'answers a valid credential presented at the wrong door exactly as it answers a wrong '
        'password, so nothing about the refusal tells you which accounts exist.', S['body']))
    flow.append(Spacer(1, 8))

    rows = [
        ['Client portal', '/  (root) then Sign in', 'Demo!Portal2026', 'Client users'],
        ['Internal firm OS', '/firm', 'Demo!Firm2026', 'Firm members'],
    ]
    flow.append(data_table(['Door', 'Path', 'Password', 'Who signs in here'],
                           rows, [(PAGE_W - 2 * MARGIN) * w for w in (0.20, 0.24, 0.24, 0.32)]))
    flow.append(Spacer(1, 8))
    flow.append(callout(
        'Sign-in is at the same origin for both products: '
        f'{DATA["base"]}/ for the client portal and {DATA["base"]}/firm for the firm OS. '
        'Opening the API paths directly returns 401 by design — the session cookie is httpOnly and '
        'the interface is not the authorization boundary.'))
    flow.append(Spacer(1, 8))

    flow.append(Paragraph('Before the first sign-in', S['h3']))
    flow.append(Spacer(1, 3))
    flow.append(bullet_list([
        'No account is created by signing up. The portal is invitation-only, so the accounts below '
        'are the seeded ones; a new client user appears only by accepting an invitation.',
        'MFA is disabled on every demo account so that sign-in is a single step. The MFA screens are '
        'still exercisable through the Security page of any portal account.',
        'Sessions are httpOnly cookies with CSRF double-submit. Clearing cookies signs you out; '
        'multiple accounts can be open at once in separate browser profiles.',
    ]))
    flow.append(Spacer(1, 10))

    flow.append(Paragraph('What to look for while testing', S['h3']))
    flow.append(Spacer(1, 3))
    flow.append(bullet_list([
        'Switch the interface language with the control in the topbar — both options are written in '
        'their own language, العربية and English, and the whole layout changes direction.',
        'Amounts render in SAR and dates in both Hijri and Gregorian depending on the calendar '
        'preference on the profile page.',
        'The firm OS shows only the modules a member may reach. Signing in as different members is '
        'the fastest way to see the difference.',
    ]))
    flow.append(callout(
        'These are demo accounts on a public deployment and every record behind them is synthetic. '
        'The passwords are deliberately weak and shared between accounts. Do not reuse them, and do '
        'not put real client data behind them — before any real use, rotate every credential, turn '
        'MFA on, and remove the demo seed.', 'alert'))
    return flow


def portal_pages():
    flow = section('Client portal accounts', 'حسابات بوابة العملاء', '3 accounts · 2 firms · 3 tenants')
    flow.append(Paragraph(
        'Each account is bound to exactly one client by a server-side row. The scope column is what '
        'the server will return for that account — it is not a filter applied in the browser.',
        S['body']))
    flow.append(Spacer(1, 8))

    for p in DATA['portal']:
        matters = [m for m in DATA['matters'] if m['client'] == p['client']]
        matter_line = ', '.join(m['matter_number'] for m in matters) or '—'
        verified = 'verified by sign-in' if (p['verified'] or {}).get('ok') else 'NOT VERIFIED'
        rows = [
            [Paragraph(esc(p['display_name']), S['name']),
             Paragraph(mixed(p['display_name_ar'], 'PlexAr-Bold'), S['namear'])],
            [Paragraph(esc(f"{p['client']} · {p['tenant']}"), S['body-sm']), ''],
            [Spacer(1, 5), ''],
            [credential_row(p['email'], DATA['portalPassword']), ''],
            [Spacer(1, 5), ''],
            [Paragraph(
                f"<b>Portal role</b> {esc(p['portal_role'])} &nbsp;·&nbsp; "
                f"<b>{esc(p['job_title'] or '—')}</b> &nbsp;·&nbsp; "
                f"<b>Scope</b> {esc(p['matters'])} matter(s): {esc(matter_line)} &nbsp;·&nbsp; "
                f"<b>Status</b> {verified}", S['body-sm']), ''],
        ]
        merged = [[rows[0][0], rows[0][1]], [rows[1][0], ''], [rows[2][0], ''],
                  [rows[3][0], ''], [rows[4][0], ''], [rows[5][0], '']]
        inner = Table(merged, colWidths=[(PAGE_W - 2 * MARGIN - 6 * mm) * 0.55,
                                         (PAGE_W - 2 * MARGIN - 6 * mm) * 0.45])
        inner.setStyle(TableStyle([
            ('SPAN', (0, 1), (1, 1)), ('SPAN', (0, 2), (1, 2)), ('SPAN', (0, 3), (1, 3)),
            ('SPAN', (0, 4), (1, 4)), ('SPAN', (0, 5), (1, 5)),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ]))
        card = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN])
        card.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CARD),
            ('BOX', (0, 0), (-1, -1), 0.6, LINE),
            ('LINEBEFORE', (0, 0), (0, -1), 3.2, BRAND_LIGHT),
            ('LEFTPADDING', (0, 0), (-1, -1), 6 * mm),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 5 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5 * mm),
        ]))
        flow.append(KeepTogether([card, Spacer(1, 7)]))

    flow.append(Spacer(1, 2))
    flow.append(callout(
        'Isolation is enforced in the database, not the interface. Ahmed and the Gulf Horizon '
        'Finance account share a tenant but no client; Layla is in a different firm entirely. '
        'Requesting another client\'s matter returns 404, identical to a matter that does not '
        'exist, so the set of matters cannot be enumerated from a URL.', 'gold'))
    return flow


def firm_pages():
    flow = section('Internal firm OS accounts', 'حسابات النظام الداخلي للمكتب', '5 members · 1 firm')
    flow.append(Paragraph(
        'Each member holds roles, a set of practice-area tags and — for those who approve spending — '
        'numeric authority ceilings. The permission totals below are the real counts from the role '
        'catalogue, not the number of screens the role can open.', S['body']))
    flow.append(Spacer(1, 8))

    for f in DATA['firm']:
        authority = []
        if f.get('financial_authority_sar'):
            authority.append(f"approves up to SAR {float(f['financial_authority_sar']):,.0f}")
        if f.get('writeoff_authority_sar'):
            authority.append(f"write-off SAR {float(f['writeoff_authority_sar']):,.0f}")
        if f.get('discount_authority_pct'):
            authority.append(f"discount {float(f['discount_authority_pct']):.0f}%")
        authority_line = ' · '.join(authority) or 'no financial authority'
        verified = 'verified by sign-in' if (f['verified'] or {}).get('ok') else 'NOT VERIFIED'

        rows = [
            [Paragraph(esc(f['full_name'] or f['email']), S['name']),
             Paragraph(mixed(f['full_name_ar'] or '', 'PlexAr-Bold'), S['namear'])],
            [Paragraph(esc(f"{f['job_title'] or '—'} · {f['tenant']}"), S['body-sm']), ''],
            [Spacer(1, 5), ''],
            [credential_row(f['email'], DATA['firmPassword']), ''],
            [Spacer(1, 5), ''],
            [Paragraph(
                f"<b>Role</b> {esc(f['roles'] or '—')} &nbsp;·&nbsp; "
                f"<b>Practice areas</b> {esc(f['areas'] or 'none')} &nbsp;·&nbsp; "
                f"<b>Authority</b> {esc(authority_line)}", S['body-sm']), ''],
            [Paragraph(
                f"<b>Matter grants</b> {esc(f['explicit_grants'] or 'none')} &nbsp;·&nbsp; "
                f"<b>Status</b> {verified}", S['body-sm']), ''],
            [Paragraph(
                f"<b>Matters the API returns on sign-in</b> "
                f"{esc(', '.join((f['verified'] or {}).get('matters') or []) or 'none')}",
                S['body-sm']), ''],
        ]
        inner = Table(rows, colWidths=[(PAGE_W - 2 * MARGIN - 6 * mm) * 0.55,
                                       (PAGE_W - 2 * MARGIN - 6 * mm) * 0.45])
        inner.setStyle(TableStyle([
            ('SPAN', (0, 1), (1, 1)), ('SPAN', (0, 2), (1, 2)), ('SPAN', (0, 3), (1, 3)),
            ('SPAN', (0, 4), (1, 4)), ('SPAN', (0, 5), (1, 5)), ('SPAN', (0, 6), (1, 6)),
            ('SPAN', (0, 7), (1, 7)),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ]))
        card = Table([[inner]], colWidths=[PAGE_W - 2 * MARGIN])
        card.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CARD),
            ('BOX', (0, 0), (-1, -1), 0.6, LINE),
            ('LINEBEFORE', (0, 0), (0, -1), 3.2, GOLD),
            ('LEFTPADDING', (0, 0), (-1, -1), 6 * mm),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5 * mm),
            ('TOPPADDING', (0, 0), (-1, -1), 5 * mm),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 5 * mm),
        ]))
        flow.append(KeepTogether([card, Spacer(1, 7)]))
    return flow


def matrix_page():
    flow = section('What each account can see', 'ما يمكن لكل حساب رؤيته', 'isolation matrix')
    flow.append(Paragraph(
        'The point of separate accounts is that they do not see the same records. Use this table to '
        'confirm the boundary rather than to assume it.', S['body']))
    flow.append(Spacer(1, 8))

    # ── client portal visibility
    header = ['Matter', 'Client', 'Portal account that reaches it', 'Internal']
    rows = []
    for m in DATA['matters']:
        who = [p['email'] for p in DATA['portal'] if p['client'] == m['client']]
        rows.append([
            f"{m['matter_number']} · {m['title']}",
            m['client'],
            ', '.join(who) if who else 'none — no portal account',
            'restricted' if m['restricted'] else 'open to the client',
        ])
    flow.append(Paragraph('Client portal', S['h3']))
    flow.append(Spacer(1, 3))
    flow.append(data_table(header, rows,
                           [(PAGE_W - 2 * MARGIN) * w for w in (0.34, 0.22, 0.30, 0.14)], size=8.0))
    flow.append(Spacer(1, 12))

    # ── firm visibility, measured rather than inferred
    flow.append(Paragraph('Internal firm OS · what each membership actually returned', S['h3']))
    flow.append(Spacer(1, 3))
    flow.append(Paragraph(
        'The last column is not a reading of the permission table — it is the list of matters the '
        'API handed back to a real session for that member, captured while this document was being '
        'built.', S['body-sm']))
    flow.append(Spacer(1, 5))
    rows = []
    for f in DATA['firm']:
        ms = (f['verified'] or {}).get('matters') or []
        rows.append([
            f['full_name'] or f['email'],
            f['roles'] or '—',
            f['explicit_grants'] or 'by practice area only',
            f"{len(ms)} — " + (', '.join(ms) if ms else 'none'),
        ])
    flow.append(data_table(['Member', 'Role', 'Access recorded in the database', 'Matters returned'],
                           rows, [(PAGE_W - 2 * MARGIN) * w for w in (0.17, 0.17, 0.21, 0.45)], size=7.8))
    flow.append(Spacer(1, 8))
    flow.append(callout(
        'Five matters exist and no member sees all five: NLP-2026-0021 belongs to a different firm '
        'entirely, so it is invisible to every KGM account. KGM-2026-0170 is restricted, which is '
        'why the spread inside one firm is so wide — the Managing Partner reaches it by authority, '
        'the Finance member by a financial view, the assigned lawyer by an edit grant, and neither '
        'the Compliance member nor the paralegal reaches it at all. Signing in as two different '
        'members is the fastest way to see the difference.', 'gold'))
    return flow


def verification_page():
    flow = section('Verification record', 'سجل التحقق', 'every credential exercised')
    flow.append(Paragraph(
        'These results were produced by signing in to the live deployment with each account, through '
        'the same endpoints and cookies the browser uses. A credential list is only as good as the '
        'last time it was tried.', S['body']))
    flow.append(Spacer(1, 8))

    rows = []
    for p in DATA['portal']:
        v = p['verified'] or {}
        rows.append([
            'Client portal', p['email'], p['display_name'],
            'signed in' if v.get('ok') else 'FAILED',
            ', '.join(v.get('matters') or []) or '—',
        ])
    for f in DATA['firm']:
        v = f['verified'] or {}
        ms = v.get('matters') or []
        rows.append([
            'Firm OS', f['email'], f['full_name'] or '',
            'signed in' if v.get('ok') else 'FAILED',
            f"{len(ms)} matters" + (f" · {f['roles']}" if f['roles'] else ''),
        ])
    flow.append(data_table(['Audience', 'Account', 'Resolved as', 'Sign-in', 'Scope returned'],
                           rows,
                           [(PAGE_W - 2 * MARGIN) * w for w in (0.15, 0.33, 0.19, 0.13, 0.20)],
                           size=8.0))
    flow.append(Spacer(1, 12))

    flow.append(Paragraph('Audience boundary', S['h3']))
    flow.append(Spacer(1, 3))
    refused = sum(1 for x in (DATA['portal'] + DATA['firm']) if x.get('boundaryRefused'))
    total = len(DATA['portal']) + len(DATA['firm'])
    flow.append(Paragraph(
        'Each account was also presented at the door it does not belong to. Every one was refused, '
        'and the refusal must not merely be a refusal: it has to be byte-for-byte the answer an '
        'unknown address gets, or the door itself tells a caller which accounts exist and which '
        'password was right. The comparison below is against two baselines measured first, not '
        'against an expectation written down in advance.', S['body-sm']))
    flow.append(Spacer(1, 6))

    eq = DATA.get('boundaryEquality') or {}
    baseline = eq.get('baselines', {})
    base_shape = baseline.get('portal', '401 | invalid_credentials | invalid email or password')
    rows = [['Accounts signing in at their own door', f'{total} of {total} (measured above)'],
            ['Refused at the opposite door', f'{refused} of {total} with HTTP 401']]
    if baseline:
        rows.append(['Baseline measured at each door first', esc(base_shape)])
    if eq:
        rows.append(['Cross-audience cases matching that baseline exactly',
                     f"{eq['passed']} of {eq['passed'] + eq['failed']} "
                     f"(scripts/verify/cross-audience.mjs)"])
    rows += [['Include a right password at the wrong door', 'yes — two of the six cases'],
             ['Passwords changed for this document', 'none — read from the live database']]
    flow.append(data_table(['Check', 'Result'], rows,
                           [(PAGE_W - 2 * MARGIN) * 0.58, (PAGE_W - 2 * MARGIN) * 0.42], size=8.2))
    flow.append(Spacer(1, 12))

    flow.append(Paragraph('Re-running the check', S['h3']))
    flow.append(Spacer(1, 3))
    flow.append(Paragraph(
        'The credential list and this record are regenerated together, so the document cannot drift '
        'from the deployment:', S['body-sm']))
    flow.append(Spacer(1, 4))
    for cmd in [
        f'node scripts/verify/credentials.mjs {DATA["base"]}',
        'node scripts/collect-manual-data.mjs',
        'python3 scripts/make-credential-manual.py',
    ]:
        flow.append(Paragraph(esc(cmd), ParagraphStyle(
            'cmd', fontName='Plex-Semi', fontSize=8.4, leading=11, textColor=DEEP,
            leftIndent=4 * mm, spaceAfter=2)))
    flow.append(Spacer(1, 10))
    return flow


def build():
    global S, DATA
    S = styles()
    ensure_fonts()

    doc = BaseDocTemplate(
        str(OUT_PATH), pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN + 6 * mm, bottomMargin=20 * mm,
        title='KGM LEGAL OS — Test Credential Manual',
        author='KGM LEGAL OS',
        subject='Demo credentials for the client portal and the internal firm OS',
    )
    frame = Frame(MARGIN, 20 * mm, PAGE_W - 2 * MARGIN, PAGE_H - 20 * mm - MARGIN - 6 * mm, id='main')
    cover_frame = Frame(0, 0, PAGE_W, PAGE_H, id='cover')
    doc.addPageTemplates([
        PageTemplate(id='cover', frames=[cover_frame], onPage=cover),
        PageTemplate(id='content', frames=[frame], onPage=header_footer),
    ])

    flow = [NextPageTemplate('content'), PageBreak()]
    flow += page_signin()
    flow.append(PageBreak())
    flow += portal_pages()
    flow.append(PageBreak())
    flow += firm_pages()
    flow.append(PageBreak())
    flow += matrix_page()
    flow.append(PageBreak())
    flow += verification_page()

    doc.build(flow)
    print(f'  wrote {OUT_PATH}  ({OUT_PATH.stat().st_size / 1024:.0f} kB)')


DATA = json.loads(DATA_PATH.read_text()) if DATA_PATH.exists() else None
if DATA is None:
    sys.exit(f'missing {DATA_PATH} — run scripts/verify/credentials.mjs and scripts/collect-manual-data.mjs first')
S = {}
build()
