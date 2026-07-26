/**
 * Role-based access control.
 *
 * A permission is a `resource:action` string. A role holds a list of them in
 * staff_roles.permissions (jsonb). Two wildcards are supported:
 *
 *   "*"            - everything (administrator only)
 *   "patients:*"   - every action on that resource
 *
 * Keeping the catalogue here (rather than only in the database) means the API
 * and the seed script agree on what exists, and typos surface at boot.
 */

export const PERMISSIONS = {
  // Patients & records
  'patients:read': 'View patient demographics and records',
  'patients:write': 'Create and edit patient records',
  'patients:delete': 'Archive patient records',
  'visits:read': 'View visits and visit history',
  'visits:write': 'Create and update visits',
  'queue:manage': 'Call, transfer, prioritise and clear the waiting queue',
  'records:read': 'View clinical notes and examinations',
  'records:write': 'Write clinical notes and examinations',

  // Clinical
  'vitals:read': 'View recorded vitals',
  'vitals:write': 'Record vitals',
  'diagnoses:write': 'Record diagnoses',
  'treatments:write': 'Create treatment plans',
  'prescriptions:read': 'View prescriptions',
  'prescriptions:write': 'Prescribe medication',
  'discharge:write': 'Discharge patients',
  'certificates:write': 'Issue medical certificates',

  // Departments
  'pharmacy:read': 'View the pharmacy queue',
  'pharmacy:manage': 'Fill, dispense and reject prescriptions',
  'lab:read': 'View laboratory orders and results',
  'lab:order': 'Order laboratory tests',
  'lab:result': 'Enter laboratory results',
  'radiology:read': 'View imaging orders',
  'radiology:order': 'Order imaging studies',
  'radiology:interpret': 'Write radiology interpretations',
  'surgery:read': 'View surgical records',
  'surgery:write': 'Create and update surgical records',

  // Business
  'appointments:read': 'View the appointment calendar',
  'appointments:write': 'Schedule, reschedule and cancel appointments',
  'billing:read': 'View invoices and payments',
  'billing:write': 'Create invoices and record payments',
  'insurance:read': 'View insurance policies',
  'insurance:verify': 'Verify or deny insurance coverage',

  // Operations
  'messaging:read': 'Read internal messages',
  'messaging:write': 'Send internal messages',
  'emergency:activate': 'Activate an emergency code',
  'emergency:resolve': 'Resolve an emergency code',
  'stats:read': 'View the statistics dashboard',
  'reports:read': 'Run and export reports',

  // Administration
  'staff:read': 'View staff directory',
  'staff:manage': 'Create, edit and deactivate staff accounts',
  'catalog:manage': 'Edit medication, diagnosis and test catalogues',
  'settings:manage': 'Change clinic settings',
  'audit:read': 'Read the audit log',
};

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);

/**
 * Default roles, used by the seed script. `rank` is an authority ordering -
 * lower is more senior - used to stop staff editing accounts above their level.
 */
export const DEFAULT_ROLES = [
  {
    code: 'administrator',
    name: 'Administrator',
    description: 'Full system access, including staff, settings and audit logs.',
    rank: 0,
    permissions: ['*'],
  },
  {
    code: 'doctor',
    name: 'Physician',
    description: 'Full clinical access: diagnose, prescribe, admit, discharge, order.',
    rank: 10,
    permissions: [
      'patients:read', 'patients:write',
      'visits:read', 'visits:write', 'queue:manage',
      'records:read', 'records:write',
      'vitals:read', 'vitals:write',
      'diagnoses:write', 'treatments:write',
      'prescriptions:read', 'prescriptions:write',
      'discharge:write', 'certificates:write',
      'lab:read', 'lab:order',
      'radiology:read', 'radiology:order', 'radiology:interpret',
      'surgery:read', 'surgery:write',
      'appointments:read', 'appointments:write',
      'billing:read',
      'insurance:read',
      'messaging:read', 'messaging:write',
      'emergency:activate', 'emergency:resolve',
      'stats:read', 'reports:read',
      'staff:read',
      'pharmacy:read',
    ],
  },
  {
    code: 'nurse',
    name: 'Nurse',
    description: 'Vitals, triage notes, lab requests and queue support.',
    rank: 20,
    permissions: [
      'patients:read', 'patients:write',
      'visits:read', 'visits:write', 'queue:manage',
      'records:read', 'records:write',
      'vitals:read', 'vitals:write',
      'prescriptions:read',
      'lab:read', 'lab:order',
      'radiology:read',
      'surgery:read',
      'appointments:read', 'appointments:write',
      'insurance:read',
      'messaging:read', 'messaging:write',
      'emergency:activate',
      'stats:read',
      'staff:read',
    ],
  },
  {
    code: 'pharmacist',
    name: 'Pharmacist',
    description: 'Review, fill and dispense prescriptions.',
    rank: 30,
    permissions: [
      'patients:read',
      'visits:read',
      'prescriptions:read',
      'pharmacy:read', 'pharmacy:manage',
      'catalog:manage',
      'billing:read',
      'messaging:read', 'messaging:write',
      'stats:read',
      'staff:read',
    ],
  },
  {
    code: 'lab_tech',
    name: 'Laboratory Technician',
    description: 'Process laboratory orders and enter results.',
    rank: 30,
    permissions: [
      'patients:read',
      'visits:read',
      'lab:read', 'lab:order', 'lab:result',
      'messaging:read', 'messaging:write',
      'stats:read',
      'staff:read',
    ],
  },
  {
    code: 'radiology_tech',
    name: 'Radiology Technician',
    description: 'Perform imaging studies and upload images.',
    rank: 30,
    permissions: [
      'patients:read',
      'visits:read',
      'radiology:read', 'radiology:order',
      'lab:read',
      'messaging:read', 'messaging:write',
      'stats:read',
      'staff:read',
    ],
  },
  {
    code: 'receptionist',
    name: 'Receptionist',
    description: 'Check-in, queue management and appointment scheduling.',
    rank: 40,
    permissions: [
      'patients:read', 'patients:write',
      'visits:read', 'visits:write', 'queue:manage',
      'appointments:read', 'appointments:write',
      'billing:read', 'billing:write',
      'insurance:read', 'insurance:verify',
      'messaging:read', 'messaging:write',
      'emergency:activate',
      'stats:read',
      'staff:read',
    ],
  },
];

/**
 * Does this permission list satisfy `required`?
 * @param {string[]} granted permissions held by the actor
 * @param {string} required e.g. 'prescriptions:write'
 */
export function hasPermission(granted, required) {
  if (!Array.isArray(granted) || granted.length === 0) return false;
  if (granted.includes('*')) return true;
  if (granted.includes(required)) return true;

  const [resource] = required.split(':');
  return granted.includes(`${resource}:*`);
}

/** True when the actor holds at least one of `required`. */
export function hasAnyPermission(granted, required) {
  return required.some((perm) => hasPermission(granted, perm));
}

/** Expand wildcards into the concrete list, for showing a role in the UI. */
export function expandPermissions(granted) {
  if (!Array.isArray(granted)) return [];
  if (granted.includes('*')) return [...ALL_PERMISSIONS];

  const expanded = new Set();
  for (const perm of granted) {
    if (perm.endsWith(':*')) {
      const resource = perm.slice(0, -2);
      ALL_PERMISSIONS.filter((p) => p.startsWith(`${resource}:`)).forEach((p) => expanded.add(p));
    } else if (PERMISSIONS[perm]) {
      expanded.add(perm);
    }
  }
  return [...expanded];
}

/** Sanity-check the built-in roles at boot. Returns a list of problems. */
export function validateDefaultRoles() {
  const problems = [];
  for (const role of DEFAULT_ROLES) {
    for (const perm of role.permissions) {
      if (perm !== '*' && !perm.endsWith(':*') && !PERMISSIONS[perm]) {
        problems.push(`Role "${role.code}" references unknown permission "${perm}"`);
      }
    }
  }
  return problems;
}
