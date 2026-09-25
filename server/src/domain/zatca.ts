/**
 * ZATCA E-INVOICING — THE DOCUMENT ITSELF  (analysis I · P0.2)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Pure. No I/O, no database, no network, no clock. Everything here takes values and
 * returns a string or bytes, so the shape of a tax invoice can be tested without a
 * database and — more importantly — re-derived years later when a regulator asks
 * what was actually on document 41.
 *
 * WHAT THIS FILE DOES NOT DO, DELIBERATELY
 *   It does not sign, and it does not talk to ZATCA.
 *
 *   A Phase 2 invoice is signed with the ECDSA private key belonging to the
 *   certificate ZATCA issued to that device, and the signature must be verifiable
 *   against the public key in that same certificate. A module that manufactured a
 *   signature locally would produce a document that looks complete and fails
 *   verification — the worst possible outcome, because it fails at the BUYER, who
 *   cannot claim the input VAT, rather than here where it could be seen.
 *
 *   So the signature, the public key and the certificate stamp are INPUTS. When a
 *   real CSID is onboarded they come from `InvoiceSigner`; until then they are
 *   absent, `buildQrPayload` emits the five Phase 1 tags, and the invoice cannot be
 *   marked cleared. The absence is visible in the document rather than papered over.
 *
 * THE THREE THINGS THAT MUST BE EXACTLY RIGHT
 *   1. The TLV encoding. Tag, length, value — one byte each for the first two, UTF-8
 *      for the value, the whole thing base64. A length byte computed on characters
 *      instead of BYTES produces a QR that scans on English text and corrupts on
 *      Arabic, which is the language most of these documents are written in.
 *   2. The hash. SHA-256 over the invoice XML, base64. It is what the chain is built
 *      from, so a hash computed over anything other than exactly the bytes that were
 *      submitted breaks the chain for every document after it.
 *   3. The invoice type code. `cbc:InvoiceTypeCode` carries the numeric code (388
 *      for a tax invoice, 381 for a credit note) AND a `name` attribute whose first
 *      two digits choose the path: `01…` is standard (B2B, CLEARED before the buyer
 *      sees it) and `02…` is simplified (B2C, REPORTED within 24 hours). Getting
 *      those two digits wrong sends a document down the wrong process entirely.
 */

import { createHash } from 'node:crypto';

/* ─────────────────────────────────────────────────────────────────────────────
 * TYPES
 * ───────────────────────────────────────────────────────────────────────────── */

/** Which of the two processes this document takes. Not a preference — a fact. */
export type InvoiceSubtype = 'standard' | 'simplified';

/**
 * The signature material, once a real certificate exists.
 *
 * All three are required together: a signature with no public key cannot be
 * verified, and a public key with no stamp is not evidence of anything.
 */
export interface InvoiceSignature {
  /** base64 ECDSA signature over the invoice hash. */
  signature: string;
  /** base64 DER public key of the signing certificate. */
  publicKey: string;
  /** base64 signature over the public key — the certificate "stamp". */
  stamp: string;
}

export interface QrInput {
  sellerName: string;
  vatRegistrationNumber: string;
  /** ISO 8601 with offset. The moment of supply, not the moment of printing. */
  timestamp: string;
  /** The VAT-INCLUSIVE total, as a decimal string with 2 places. */
  totalWithVat: string;
  /** The VAT amount alone, as a decimal string with 2 places. */
  vatTotal: string;
  /** base64 SHA-256 of the invoice XML. Present whenever a QR is generated at all. */
  invoiceHash?: string | null;
  signature?: InvoiceSignature | null;
}

export interface InvoiceLineInput {
  position: number;
  description: string;
  descriptionAr?: string | null;
  quantity: string;
  unitPrice: string;
  /** quantity × unitPrice − discount, 2 places. */
  lineExtensionAmount: string;
  discountAmount?: string | null;
  vatCategory: 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';
  vatRate: string;
  vatAmount: string;
}

export interface InvoiceXmlInput {
  /** The document type code: 388 tax invoice, 381 credit note. */
  documentTypeCode: '388' | '381';
  subtype: InvoiceSubtype;
  invoiceNumber: string;
  uuid: string;
  issueDate: string;   // YYYY-MM-DD
  issueTime: string;   // HH:MM:SS
  supplyDate?: string | null;  // KSA-5, required on a standard tax invoice
  currency: string;
  /**
   * The invoice counter value. ZATCA's own identifier for this document within the
   * device's sequence, carried in AdditionalDocumentReference as ICV.
   */
  icv: number;
  /** base64 hash of the previous invoice from the same device (PIH). */
  previousInvoiceHash: string;
  seller: {
    name: string;
    nameAr?: string | null;
    vatRegistrationNumber: string;
    commercialRegistration: string;
    address: string;
    city?: string | null;
    postalCode?: string | null;
    country: string;
  };
  buyer: {
    name: string;
    nameAr?: string | null;
    vatNumber?: string | null;
    address?: string | null;
  };
  lines: InvoiceLineInput[];
  subtotal: string;
  vatTotal: string;
  total: string;
  /** The base64 TLV QR, embedded in the document as well as printed on it. */
  qrPayload: string;
  /** For a credit note: the invoice being corrected. Mandatory in that case. */
  billingReference?: { invoiceNumber: string; uuid: string; issueDate: string } | null;
  /** The reason for issuance, carried as cbc:Note. */
  note?: string | null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1 · THE QR CODE
 * ───────────────────────────────────────────────────────────────────────────── */

/** The nine Phase 2 tags, in the order the regulation numbers them. */
export const QR_TAGS = {
  sellerName: 1,
  vatNumber: 2,
  timestamp: 3,
  invoiceTotal: 4,
  vatTotal: 5,
  invoiceHash: 6,
  signature: 7,
  publicKey: 8,
  stamp: 9,
} as const;

/**
 * Tag-Length-Value, base64.
 *
 * THE LENGTH IS IN BYTES, NOT CHARACTERS.
 *
 * This is the whole reason the function is written by hand rather than with a
 * library's `Buffer.byteLength` used casually. ZATCA specifis the length as the
 * number of bytes of the UTF-8 encoding of the value. `'شركة'.length` is 4, and its
 * UTF-8 encoding is 8 bytes. A generator that uses the string length produces a QR
 * that is correct for every Latin seller name and corrupt for every Arabic one —
 * and since the seller name is the FIRST tag, every subsequent tag is misread too.
 */
export function tlvEncode(fields: Array<{ tag: number; value: string }>): string {
  const chunks: Buffer[] = [];
  for (const { tag, value } of fields) {
    if (tag < 1 || tag > 255) {
      throw new Error(`zatca: tag ${tag} is outside 1..255`);
    }
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length > 255) {
      /*
        Refuse rather than truncate. A truncated seller name is a wrong seller name,
        and a QR that cannot hold the value means the document does not comply — the
        correct response is to say so, not to emit something that scans.
      */
      throw new Error(`zatca: tag ${tag} is ${bytes.length} bytes, beyond the 255 a TLV length byte can hold`);
    }
    chunks.push(Buffer.from([tag, bytes.length]), bytes);
  }
  return Buffer.concat(chunks).toString('base64');
}

/**
 * Build the QR payload.
 *
 * With a signature the payload carries all nine tags. Without one it carries the
 * first five, which is what Phase 1 specifies and — crucially — is a COMPLETE and
 * honest Phase 1 QR rather than a Phase 2 QR with three empty tags. Emitting empty
 * tags 6–9 would produce a code that a ZATCA verifier reads as a Phase 2 document
 * with an invalid signature, which is a worse failure than not claiming Phase 2.
 */
export function buildQrPayload(input: QrInput): string {
  const base = [
    { tag: QR_TAGS.sellerName, value: input.sellerName },
    { tag: QR_TAGS.vatNumber, value: input.vatRegistrationNumber },
    { tag: QR_TAGS.timestamp, value: input.timestamp },
    { tag: QR_TAGS.invoiceTotal, value: input.totalWithVat },
    { tag: QR_TAGS.vatTotal, value: input.vatTotal },
  ];

  if (!input.signature) {
    return tlvEncode(base);
  }

  if (!input.invoiceHash) {
    throw new Error('zatca: a signed QR requires the invoice hash — a signature signs something');
  }

  return tlvEncode([
    ...base,
    { tag: QR_TAGS.invoiceHash, value: input.invoiceHash },
    { tag: QR_TAGS.signature, value: input.signature.signature },
    { tag: QR_TAGS.publicKey, value: input.signature.publicKey },
    { tag: QR_TAGS.stamp, value: input.signature.stamp },
  ]);
}

/** The inverse, for tests and for anything that wants to read a QR back. */
export function tlvDecode(payload: string): Array<{ tag: number; value: string }> {
  const buf = Buffer.from(payload, 'base64');
  const out: Array<{ tag: number; value: string }> = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    if (i + 2 + len > buf.length) {
      throw new Error('zatca: TLV is truncated — the length byte overruns the payload');
    }
    out.push({ tag, value: buf.subarray(i + 2, i + 2 + len).toString('utf8') });
    i += 2 + len;
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2 · THE HASH AND THE CHAIN
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * SHA-256 over the invoice XML, base64 — the value the next invoice chains to.
 *
 * `xml` must be the exact bytes that were submitted. Re-serialising the document
 * with a different whitespace convention produces a different hash, and a chain
 * whose links do not match cannot be attested — so callers hash what they sent, not
 * what they would send again.
 */
export function invoiceHash(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('base64');
}

/** The hash of a document that does not exist yet — what the FIRST invoice chains to. */
export const GENESIS_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

/* ─────────────────────────────────────────────────────────────────────────────
 * 3 · THE UBL DOCUMENT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * The seven-digit transaction code.
 *
 *   position 1–2  the subtype: `01` standard (cleared), `02` simplified (reported)
 *   position 3    third-party invoice
 *   position 4    nominal supply
 *   position 5    export
 *   position 6    summary
 *   position 7    self-billed
 *
 * Only the first two are used here. The other five describe situations this system
 * does not model, and setting one of them by accident would change how the document
 * is processed — an export invoice reported as domestic, for instance. So they are
 * zeros, and `subtypeToTransactionCode` is the single place that decides them.
 */
export function subtypeToTransactionCode(subtype: InvoiceSubtype): string {
  return subtype === 'standard' ? '0100000' : '0200000';
}

/**
 * The VAT category code, in the UN/EDIFACT 5305 codelist ZATCA uses.
 *
 *   S  standard rate
 *   Z  zero rated
 *   E  exempt
 *   O  out of scope
 *
 * The rate is carried separately and independently: a category `S` line at 0% is a
 * contradiction, and the generator refuses it rather than emitting a document whose
 * own two fields disagree.
 */
export function vatCategoryCode(category: InvoiceLineInput['vatCategory']): string {
  switch (category) {
    case 'standard': return 'S';
    case 'zero_rated': return 'Z';
    case 'exempt': return 'E';
    case 'out_of_scope': return 'O';
  }
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Always two decimal places. A tax invoice shows 100.00, not 100 and not 100.000. */
const money = (s: string | number): string => {
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) throw new Error(`zatca: ${String(s)} is not a number`);
  return n.toFixed(2);
};

/**
 * The UBL 2.1 invoice.
 *
 * Written as string concatenation rather than with an XML library because the
 * element ORDER is normative in UBL and a serialiser that reorders attributes or
 * self-closes differently changes the bytes — and the bytes are hashed.
 *
 * Elements included because they are REQUIRED, not because they are nice:
 *   · `cbc:ProfileID` reporting:1.0 — BR-KSA-EN16931-01 requires this value on
 *     Saudi documents regardless of which process the document takes. The subtype
 *     is not encoded here; it is in `InvoiceTypeCode/@name`.
 *   · `cac:AdditionalDocumentReference` ICV and PIH — the chain itself.
 *   · `cac:AdditionalDocumentReference` with the QR, base64 — the document carries
 *     the same code that is printed on it.
 *   · KSA-5 supply date on a standard tax invoice.
 */
export function buildInvoiceXml(input: InvoiceXmlInput): string {
  const typeCodeName = subtypeToTransactionCode(input.subtype);

  /* A category at a rate it cannot have is refused here, where the reason is clear,
     rather than by a validator at ZATCA where the reason is a code. */
  for (const l of input.lines) {
    const rate = Number(l.vatRate);
    if ((l.vatCategory === 'zero_rated' || l.vatCategory === 'exempt' || l.vatCategory === 'out_of_scope')
        && Number(l.vatRate) !== 0) {
      throw new Error(`zatca: line ${l.position} is ${l.vatCategory} with a rate of ${l.vatRate}`);
    }
    if (l.vatCategory === 'standard' && rate <= 0) {
      throw new Error(`zatca: line ${l.position} is standard-rated at ${l.vatRate}`);
    }
  }

  if (input.documentTypeCode === '381' && !input.billingReference) {
    throw new Error('zatca: a credit note must reference the invoice it corrects');
  }

  const lines = input.lines.map((l) => `
    <cac:InvoiceLine>
      <cbc:ID>${l.position}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${l.quantity}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(l.lineExtensionAmount)}</cbc:LineExtensionAmount>
      <cac:TaxTotal>
        <cbc:TaxAmount currencyID="${input.currency}">${money(l.vatAmount)}</cbc:TaxAmount>
        <cbc:RoundingAmount currencyID="${input.currency}">${money(Number(l.lineExtensionAmount) + Number(l.vatAmount))}</cbc:RoundingAmount>
      </cac:TaxTotal>
      <cac:Item>
        <cbc:Name>${xmlEscape(l.descriptionAr || l.description)}</cbc:Name>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="${input.currency}">${money(l.unitPrice)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('');

  /*
    Tax subtotals are grouped BY CATEGORY AND RATE, not listed per line. A document
    with three standard-rated lines has one subtotal; one with a standard line and an
    exempt line has two. This is the structure the return is built from.
  */
  const groups = new Map<string, { taxable: number; tax: number; category: string; rate: string; reason?: string }>();
  for (const l of input.lines) {
    const key = `${l.vatCategory}|${l.vatRate}`;
    const g = groups.get(key) ?? {
      taxable: 0, tax: 0, category: vatCategoryCode(l.vatCategory), rate: l.vatRate,
    };
    g.taxable += Number(l.lineExtensionAmount);
    g.tax += Number(l.vatAmount);
    groups.set(key, g);
  }

  const subtotals = [...groups.values()].map((g) => `
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${input.currency}">${money(g.taxable)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${input.currency}">${money(g.tax)}</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:ID>${g.category}</cbc:ID>
          <cbc:Percent>${Number(g.rate) * 100}</cbc:Percent>
          <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>`).join('');

  const billingReference = input.billingReference
    ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${xmlEscape(input.billingReference.invoiceNumber)}</cbc:ID>
      <cbc:UUID>${input.billingReference.uuid}</cbc:UUID>
      <cbc:IssueDate>${input.billingReference.issueDate}</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${xmlEscape(input.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${input.uuid}</cbc:UUID>
  <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${typeCodeName}">${input.documentTypeCode}</cbc:InvoiceTypeCode>
${input.note ? `  <cbc:Note>${xmlEscape(input.note)}</cbc:Note>\n` : ''}  <cbc:DocumentCurrencyCode>${input.currency}</cbc:DocumentCurrencyCode>
${input.supplyDate ? `  <cbc:TaxCurrencyCode>${input.currency}</cbc:TaxCurrencyCode>\n  <cac:Delivery>\n    <cbc:ActualDeliveryDate>${input.supplyDate}</cbc:ActualDeliveryDate>\n  </cac:Delivery>\n` : ''}${billingReference}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${input.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.qrPayload}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="CRN">${xmlEscape(input.seller.commercialRegistration)}</cbc:ID></cac:PartyIdentification>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEscape(input.seller.address)}</cbc:StreetName>
        <cbc:CityName>${xmlEscape(input.seller.city ?? '')}</cbc:CityName>
        <cbc:PostalZone>${xmlEscape(input.seller.postalCode ?? '')}</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>${input.seller.country}</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${xmlEscape(input.seller.vatRegistrationNumber)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(input.seller.nameAr || input.seller.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
${input.buyer.vatNumber ? `      <cac:PartyTaxScheme>\n        <cbc:CompanyID>${xmlEscape(input.buyer.vatNumber)}</cbc:CompanyID>\n        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>\n      </cac:PartyTaxScheme>\n` : ''}${input.buyer.address ? `      <cac:PostalAddress>\n        <cbc:StreetName>${xmlEscape(input.buyer.address)}</cbc:StreetName>\n        <cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country>\n      </cac:PostalAddress>\n` : ''}      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${xmlEscape(input.buyer.nameAr || input.buyer.name)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${money(input.vatTotal)}</cbc:TaxAmount>${subtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${money(input.subtotal)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${money(input.subtotal)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${money(input.total)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${money(input.total)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>
`;
}

/**
 * Does the document's own arithmetic hold?
 *
 * BR-CO-15 and its neighbours: the tax total is the sum of the subtotals, the
 * payable amount is the tax-exclusive plus the tax, and the lines add up to both.
 * Checked here so an invoice that does not add up is refused BEFORE it is hashed and
 * chained — because once it is in the chain, correcting it costs a credit note.
 */
export function reconcileInvoice(input: {
  lines: Array<{ lineExtensionAmount: string; vatAmount: string }>;
  subtotal: string;
  vatTotal: string;
  total: string;
}): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const cents = (s: string | number) => Math.round(Number(s) * 100);

  const lineNet = input.lines.reduce((a, l) => a + cents(l.lineExtensionAmount), 0);
  const lineVat = input.lines.reduce((a, l) => a + cents(l.vatAmount), 0);

  if (lineNet !== cents(input.subtotal)) {
    problems.push(`lines sum to ${(lineNet / 100).toFixed(2)}, the invoice says ${input.subtotal}`);
  }
  if (lineVat !== cents(input.vatTotal)) {
    problems.push(`line VAT sums to ${(lineVat / 100).toFixed(2)}, the invoice says ${input.vatTotal}`);
  }
  if (cents(input.subtotal) + cents(input.vatTotal) !== cents(input.total)) {
    problems.push(`subtotal + VAT is ${((cents(input.subtotal) + cents(input.vatTotal)) / 100).toFixed(2)}, the invoice says ${input.total}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The date and time of supply as the QR and the document both carry it.
 *
 * ISO 8601 with the offset, seconds precision. `Date#toISOString` gives `Z`, which
 * is a valid representation of the same instant and is NOT what the specification
 * asks for — a Saudi document states its local offset, because the reporting window
 * and the tax period are both local.
 */
export function supplyTimestamp(at: Date, offsetMinutes = 180): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${shifted.toISOString().slice(0, 19)}${off}`;
}

/** The reporting deadline for a simplified invoice: 24 hours from supply. */
export function reportingDeadline(supplyAt: Date): Date {
  return new Date(supplyAt.getTime() + 24 * 60 * 60 * 1000);
}
