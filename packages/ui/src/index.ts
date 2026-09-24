/**
 * @kgm/ui — SHARED PRESENTATIONAL PRIMITIVES.
 *
 * WHAT THIS PACKAGE IS
 *   Icons, cards, tables, badges, skeletons, buttons, formatters, the i18n
 *   runtime and the design tokens. Pure presentation: nothing here knows what a
 *   matter is, who is logged in, or which URL to call.
 *
 * WHAT THIS PACKAGE DELIBERATELY DOES NOT CONTAIN
 *   - No API client.
 *   - No auth context, session store or permission resolver.
 *   - No route table.
 *   - No type that describes a server response.
 *
 * WHY THE LINE IS DRAWN THERE
 *   The client portal and the Internal Firm OS are two products with two
 *   authorization universes (§3, §6). A shared fetch wrapper is a shared idea of
 *   what a request looks like; a shared auth context is a shared idea of who the
 *   caller is. Once either exists, a bug in one product becomes a privilege
 *   boundary in the other, and the separation stops being structural and becomes
 *   a convention that someone has to remember.
 *
 *   A component that knows how to fetch is a component that knows which door to
 *   knock on. These components knock on no doors.
 *
 *   Sharing ICONS is safe because an icon cannot authorize anything. That is the
 *   test applied to every export in this package: could this, if subtly wrong,
 *   let someone see something they should not? If yes, it does not belong here.
 */
export * from './primitives/Card.js';
export * from './primitives/Button.js';
export * from './primitives/Badge.js';
export * from './primitives/Skeleton.js';
export * from './primitives/Table.js';
export * from './primitives/Field.js';
export * from './primitives/Modal.js';
export * from './primitives/Toast.js';
export * from './primitives/EmptyState.js';
export * from './primitives/Tooltip.js';
export * from './primitives/Alert.js';
export * from './icons/index.js';
export * from './brand/Logo.js';
export * from './format/index.js';
export * from './i18n/index.js';
