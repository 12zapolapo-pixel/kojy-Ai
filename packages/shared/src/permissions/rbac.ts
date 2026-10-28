/**
 * @kojyai/shared — RBAC Permission Definitions
 *
 * OWNERSHIP: packages/security/rbac enforces these.
 * API middleware checks them on every request.
 * Frontend uses them for conditional rendering (not as security enforcement).
 *
 * DESIGN: Permission = resource:action pairs.
 * Roles inherit permissions. Higher roles include all lower role permissions.
 */

export type Permission =
  // ── Bot permissions ─────────────────────────────────────────────────────────
  | "bots:read"
  | "bots:create"
  | "bots:update"
  | "bots:delete"
  | "bots:deploy"
  | "bots:start"
  | "bots:stop"
  | "bots:read_logs"
  | "bots:manage_personality"
  | "bots:manage_memory"
  | "bots:manage_relationships"
  // ── Room permissions ────────────────────────────────────────────────────────
  | "rooms:read"
  | "rooms:create"
  | "rooms:update"
  | "rooms:delete"
  | "rooms:manage_bots"
  // ── Simulation permissions ───────────────────────────────────────────────────
  | "simulations:read"
  | "simulations:create"
  | "simulations:run"
  | "simulations:stop"
  | "simulations:inject_events"
  | "simulations:chaos"
  // ── Analytics permissions ────────────────────────────────────────────────────
  | "analytics:read"
  | "analytics:export"
  | "analytics:read_advanced"
  // ── Intelligence permissions ─────────────────────────────────────────────────
  | "intelligence:read"
  | "intelligence:configure"
  | "intelligence:coaching"
  // ── Marketplace permissions ──────────────────────────────────────────────────
  | "marketplace:read"
  | "marketplace:purchase"
  | "marketplace:sell"
  | "marketplace:moderate"
  // FIX-AUDIT: marketplace:admin was used by marketplace/router.ts's
  // confirmDelivery procedure but never declared here. hasPermission() does a
  // plain array .includes() at runtime — an undeclared permission matches
  // nothing in any role's list, so confirmDelivery was uncallable by anyone,
  // including superadmin. Scoped like billing:manage (admin + superadmin).
  | "marketplace:admin"
  // ── Billing permissions ──────────────────────────────────────────────────────
  | "billing:read"
  | "billing:manage"
  | "billing:upgrade"
  // ── Org / member permissions ─────────────────────────────────────────────────
  | "org:read"
  | "org:update"
  | "org:manage_members"
  | "org:manage_billing"
  | "org:delete"
  // ── Security permissions ─────────────────────────────────────────────────────
  | "security:read_events"
  | "security:manage"
  | "audit:read"
  // ── Admin permissions ────────────────────────────────────────────────────────
  | "admin:read"       // alias for admin:read_all — kept for backwards compat
  | "admin:read_all"
  | "admin:manage_users"
  | "admin:manage_orgs"
  | "admin:feature_flags"
  | "admin:system";

import type { UserRole, UserTier } from "../types/entities.js";

/**
 * Role → Permission mapping.
 * More specific role overrides: admin includes all user permissions.
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  user: [
    "bots:read", "bots:create", "bots:update", "bots:delete",
    "bots:deploy", "bots:start", "bots:stop", "bots:read_logs",
    "bots:manage_personality", "bots:manage_memory", "bots:manage_relationships",
    "rooms:read", "rooms:create", "rooms:update", "rooms:delete", "rooms:manage_bots",
    "simulations:read", "simulations:create", "simulations:run", "simulations:stop",
    "analytics:read",
    "intelligence:read",
    "marketplace:read", "marketplace:purchase",
    "billing:read", "billing:upgrade",
    "org:read", "org:update",
  ],
  admin: [
    // inherits user + extras
    "bots:read", "bots:create", "bots:update", "bots:delete",
    "bots:deploy", "bots:start", "bots:stop", "bots:read_logs",
    "bots:manage_personality", "bots:manage_memory", "bots:manage_relationships",
    "rooms:read", "rooms:create", "rooms:update", "rooms:delete", "rooms:manage_bots",
    "simulations:read", "simulations:create", "simulations:run", "simulations:stop",
    "simulations:inject_events", "simulations:chaos",
    "analytics:read", "analytics:export", "analytics:read_advanced",
    "intelligence:read", "intelligence:configure", "intelligence:coaching",
    "marketplace:read", "marketplace:purchase", "marketplace:sell",
    "marketplace:admin",
    "billing:read", "billing:manage", "billing:upgrade",
    "org:read", "org:update", "org:manage_members", "org:manage_billing",
    "security:read_events",
    "audit:read",
    "admin:read_all", "admin:manage_users", "admin:read",
  ],
  superadmin: [
    // All permissions — no restrictions
    "bots:read", "bots:create", "bots:update", "bots:delete",
    "bots:deploy", "bots:start", "bots:stop", "bots:read_logs",
    "bots:manage_personality", "bots:manage_memory", "bots:manage_relationships",
    "rooms:read", "rooms:create", "rooms:update", "rooms:delete", "rooms:manage_bots",
    "simulations:read", "simulations:create", "simulations:run", "simulations:stop",
    "simulations:inject_events", "simulations:chaos",
    "analytics:read", "analytics:export", "analytics:read_advanced",
    "intelligence:read", "intelligence:configure", "intelligence:coaching",
    "marketplace:read", "marketplace:purchase", "marketplace:sell", "marketplace:moderate",
    "marketplace:admin",
    "billing:read", "billing:manage", "billing:upgrade",
    "org:read", "org:update", "org:manage_members", "org:manage_billing", "org:delete",
    "security:read_events", "security:manage",
    "audit:read",
    "admin:read", "admin:read_all", "admin:manage_users", "admin:manage_orgs",
    "admin:feature_flags", "admin:system",
  ],
};

/**
 * Tier → Feature gates.
 * These are checked AFTER role permissions pass.
 * A feature may be permitted by role but gated by tier.
 */
export const TIER_FEATURES: Record<UserTier, Partial<Record<Permission, boolean>>> = {
  free: {
    "simulations:create": false,
    "simulations:chaos": false,
    "analytics:export": false,
    "analytics:read_advanced": false,
    "marketplace:sell": false,
    "intelligence:coaching": false,
  },
  starter: {
    "simulations:chaos": false,
    "analytics:export": false,
    "marketplace:sell": false,
  },
  pro: {
    "simulations:chaos": false,
  },
  elite: {},
  enterprise: {},
  dev: {}, // Dev tier has all features
};

/** Utility: check if a user has a permission */
export function hasPermission(
  role: UserRole,
  tier: UserTier,
  permission: Permission,
): boolean {
  const rolePerms = ROLE_PERMISSIONS[role] ?? [];
  if (!rolePerms.includes(permission)) return false;
  const tierGate = TIER_FEATURES[tier]?.[permission];
  if (tierGate === false) return false;
  return true;
}
