// Ticket categories used to be a flat constant here. They're now
// department-scoped, editable rows in the categories table instead - see
// src/departments.js (categoryNames() / categoriesByDepartment()), which is
// what every former CATEGORIES.includes(...)/CATEGORIES.forEach(...) call
// site now uses.
const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
// "Waiting on Customer" pauses the aging/SLA clock for as long as a ticket
// sits in it - see src/aging.js's paused_hours accounting.
const STATUSES = ["Open", "In Progress", "Waiting on Customer", "Resolved", "Closed"];

// Aging thresholds by priority live in the sla_thresholds table now (see
// src/aging.js) - editable from /dashboard/settings, no longer a hardcoded
// constant. The historical defaults it's seeded with on first boot are in
// src/db/index.js's DEFAULT_SLA_DAYS, right next to the seeding logic.

// Tickets per dashboard page.
const PAGE_SIZE = 25;

const ASSET_CATEGORIES = ["Laptop", "Desktop", "Monitor", "Phone", "Server", "Network Equipment", "Peripheral", "Software License", "Other"];
const ASSET_STATUSES = ["Available", "Reserved", "In Use", "In Storage", "Under Repair", "Retired", "Lost"];

// Consultants (see src/consultants.js): retired, not deleted - a status
// change to 'Ended' is how an engagement ends, the same "never a hard
// DELETE" convention assets use with their own richer status set above.
const CONSULTANT_STATUSES = ["Active", "Ended"];

module.exports = {
  PRIORITIES,
  STATUSES,
  PAGE_SIZE,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  CONSULTANT_STATUSES,
};
