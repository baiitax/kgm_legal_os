#!/usr/bin/env python3
"""
scripts/check-manual-pdf.py  <pdf>

Renders the manual and measures, for every text span containing Arabic, whether
ink actually appears where the span claims to be.

WHY THIS EXISTS
  A PDF can contain correct Arabic text and still print nothing. The glyphs this
  manual uses are Arabic presentation forms drawn from a subset font; if the
  subset is missing the outlines, the text is present in the content stream, the
  extractor returns it (sometimes as NULs), the layout is right — and the page is
  blank. Reviewing a rendered thumbnail is not enough either: at 100 dpi a
  missing line looks like an empty line that was meant to be empty.

  So this asserts the only thing that matters: pixels. For each span it samples
  the rendered bitmap inside the span's box and requires a minimum ink coverage,
  and it fails loudly rather than reporting a warning.

Exit status is non-zero if any Arabic span is blank, or if the document has no
Arabic at all (which would mean the manual silently lost its bilingual half).
"""
import sys

import numpy as np
import pymupdf

ARABIC = range(0x0600, 0x0700)
PRESENTATION = list(range(0xFB50, 0xFE00)) + list(range(0xFE70, 0xFF00))


def is_arabic(text: str) -> bool:
    return any(ord(c) in ARABIC or ord(c) in PRESENTATION for c in text)


def main(path: str) -> int:
    doc = pymupdf.open(path)
    checked = blank = 0
    failures = []

    for pno in range(doc.page_count):
        page = doc[pno]
        # 200 dpi is enough to catch a missing glyph and cheap enough to keep
        scale = 200 / 72
        pix = page.get_pixmap(dpi=200)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        rgb = img[:, :, :3].astype(int)

        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    if not is_arabic(span['text']):
                        continue
                    checked += 1
                    x0, y0, x1, y1 = span['bbox']
                    # pad generously: descenders and the shadda/damma marks sit
                    # outside the reported box on shaped Arabic
                    x0, x1 = int(max(0, (x0 - 2) * scale)), int(min(pix.width, (x1 + 2) * scale))
                    y0, y1 = int(max(0, (y0 - 3) * scale)), int(min(pix.height, (y1 + 3) * scale))
                    if x1 <= x0 or y1 <= y0:
                        continue
                    patch = rgb[y0:y1, x0:x1]
                    # background = the mode colour of the patch's border pixels
                    border = np.concatenate([patch[0], patch[-1], patch[:, 0], patch[:, -1]])
                    bg = np.median(border, axis=0)
                    ink = (np.abs(patch - bg).sum(axis=2) > 30).sum()
                    density = ink / patch.shape[0] / patch.shape[1]
                    status = 'ok  ' if density > 0.012 else 'BLANK'
                    if density <= 0.012:
                        blank += 1
                        failures.append((pno + 1, span['text'][:28], span['font'], round(density, 4)))
                    print(f'  p{pno + 1}  {status} {density:6.3f}  {span["font"][:26]:26} {span["text"][:30]!r}')

    print()
    print(f'  arabic spans: {checked}   blank: {blank}   pages: {doc.page_count}')
    if checked == 0:
        print('  FAIL — the document contains no Arabic at all')
        return 1
    if blank:
        print('  FAIL — the following spans are present but render nothing:')
        for pno, text, font, density in failures:
            print(f'    page {pno}: {text!r} in {font} (ink {density})')
        return 1
    print('  PASS — every Arabic span renders')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else '/home/user/KGM-LEGAL-OS-Test-Credentials.pdf'))
