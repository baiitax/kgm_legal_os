/**
 * §46 · THE FIELD DENYLIST.
 *
 * These are the request-body keys a client portal must never accept, on any
 * endpoint. They fall into four families:
 *
 *   identity      tenant_id, client_id, user_id  — who the caller is, is decided
 *                 by the session, never by the payload.
 *   authority     role, permissions, scopes      — what the caller may do, is
 *                 resolved from client_users on every request.
 *   money         total, amount_paid, paid_at    — financial state moves only on
 *                 a signature-verified provider webhook (§21).
 *   firm internal internal_notes, risk_rating,   — the firm's work product and
 *                 storage_key, assigned_staff_id    its storage layout.
 *
 * Refusing these outright (rather than silently stripping them) is deliberate:
 * a stripped field looks like a successful request to the attacker and leaves no
 * trace for the firm. A refusal writes a FIELD_TAMPER_ATTEMPT audit event naming
 * exactly what was attempted.
 *
 * Kept in its own module so both the HTTP middleware and the domain layer can
 * enforce it without importing each other.
 */
export const FORBIDDEN_FIELDS = new Set([
  'tenant_id', 'tenantid', 'tenant', 'firm_id', 'firmid',
  'client_id', 'clientid', 'client', 'user_id', 'userid',
  'role', 'roles', 'portal_role', 'portalrole', 'internal_role',
  'permissions', 'permission', 'scopes', 'claims',
  'status', 'internal_status', 'client_status',
  'approved_by', 'approved_by_staff', 'approvedby', 'approved_at',
  'paid_at', 'amount_paid', 'amountpaid', 'total', 'subtotal', 'vat_amount',
  'created_by', 'created_by_staff', 'uploaded_by_staff_id',
  'storage_key', 'storagekey', 'storage_bucket', 'bucket', 'path',
  'client_visibility', 'visibility', 'requested',
  'national_id', 'nationalid', 'identity_verified', 'identityverified',
  'email_verified', 'email_verified_at', 'mfa_enabled',
  'confirmed_at', 'confirmed_staff_id', 'rescheduled_from',
  'internal_notes', 'internal_note', 'internal_flag', 'internal_comment',
  'risk_rating', 'conflict_cleared', 'notes_internal', 'assigned_staff_id',
  'revoked_at', 'locked_until', 'failed_login_count',
  // Prototype pollution. Not a business field, but a key that must never be
  // accepted from a request body for the same reason: it changes behaviour the
  // caller has no business changing.
  '__proto__', 'constructor', 'prototype',
]);


/** Normalizes a request key so case and separator tricks cannot evade the list. */
export function normalizeFieldKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, '_');
}

/** True when a request body key is on the denylist. */
export function isProtectedField(key: string): boolean {
  return FORBIDDEN_FIELDS.has(normalizeFieldKey(key));
}
