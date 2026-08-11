'use strict';
const db = require('./db');
const auth = require('./auth');

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount > 0) {
    console.log('Database already seeded. Skipping.');
    return;
  }

  console.log('Seeding the Unassigned Pool (site 100) + real sites...');
  db.prepare('INSERT INTO sites (id, name, location) VALUES (100, ?, ?)').run('Unassigned Pool', 'System default — reassign workers from here');
  const siteIds = [];
  ['Site 101 - North Yard', 'Site 102 - Downtown', 'Site 103 - Warehouse'].forEach((name) => {
    siteIds.push(db.prepare('INSERT INTO sites (name, location) VALUES (?, ?)').run(name, 'India').lastInsertRowid);
  });
  // Show off the status field: one site on hold, one wrapped up.
  db.prepare('UPDATE sites SET status = ? WHERE id = ?').run('on_hold', siteIds[1]);
  const site4Id = db.prepare('INSERT INTO sites (name, location, status) VALUES (?, ?, ?)').run('Site 104 - Riverside (wrapped up)', 'India', 'completed').lastInsertRowid;

  console.log('Seeding vendors...');
  // Vendor codes are auto-generated in the real app (see nextVendorCode() in
  // app.js) — the built-in Direct vendor gets a fixed "B0001"-style code and
  // regular vendors get sequential "VEN-xxx" codes, so the seed mirrors that
  // same convention rather than inventing its own. NOTE: this fixed code only
  // applies to a *fresh* install — an already-deployed database's existing
  // Direct vendor code is never renamed by any migration.
  const directVendorId = db
    .prepare('INSERT INTO vendors (vendor_code, name, contact, email, address, is_direct) VALUES (?, ?, ?, ?, ?, 1)')
    .run('B0001', 'Bilara (Direct)', '9800000001', 'hr@bilaragroup.example', 'BilaraGroup HQ, India').lastInsertRowid;
  const vendorAId = db
    .prepare('INSERT INTO vendors (vendor_code, name, contact, whatsapp, email, address) VALUES (?, ?, ?, ?, ?, ?)')
    .run('VEN-001', 'Shree Labour Suppliers', '9812345001', '9812345009', 'contact@shreelabour.example', 'MG Road, Bengaluru').lastInsertRowid;
  const vendorBId = db
    .prepare('INSERT INTO vendors (vendor_code, name, contact, email) VALUES (?, ?, ?, ?)')
    .run('VEN-002', 'Om Manpower Services', '9812345002', 'ops@ommanpower.example').lastInsertRowid;

  console.log('Seeding worker types...');
  const typeIds = {};
  ['Mason', 'Helper', 'Tile Worker', 'Electrician', 'Plumber', 'Welder', 'Carpenter'].forEach((name) => {
    typeIds[name] = db.prepare('INSERT INTO worker_types (name) VALUES (?)').run(name).lastInsertRowid;
  });

  console.log('Seeding users...');
  // Usernames for these bootstrap demo accounts are kept as simple, familiar
  // logins (not email addresses) — the "username must be an email" rule
  // (see the Users page) applies going forward to accounts created through
  // the app; changing these seeded ones would break every existing login
  // habit and test script for no real benefit.
  //
  // v10: exactly one demo account per approved role (super_admin, admin,
  // site_engineer, project_manager, labor_manager, hr, audit_manager) — the
  // 'supervisor', 'operation_head', and 'ceo' demo accounts this used to
  // seed are gone along with those roles. None of the seven approved roles
  // carries a single site_id anymore (that was 'supervisor'-only), so no
  // seeded account passes site_id here.
  auth.createUser({ username: 'superadmin1', password: 'superadmin123', name: 'Neha Kapoor', role: 'super_admin', contact: '9800000009' });
  auth.createUser({ username: 'admin', password: 'admin123', name: 'Asha Verma', role: 'admin', contact: '9800000010' });
  auth.createUser({ username: 'hr', password: 'hr123', name: 'Rohit Mehta', role: 'hr', contact: '9800000011' });
  auth.createUser({ username: 'labormanager1', password: 'labor123', name: 'Manish Bhatt', role: 'labor_manager', contact: '9800000014' });
  auth.createUser({ username: 'auditmanager1', password: 'audit123', name: 'Priya Chawla', role: 'audit_manager', contact: '9800000015' });
  const pm1Id = auth.createUser({ username: 'pm1', password: 'pm123', name: 'Farah Sheikh', role: 'project_manager', contact: '9800000018' });
  const se1Id = auth.createUser({ username: 'se1', password: 'se123', name: 'Karan Vora', role: 'site_engineer', contact: '9800000019' });
  // Demo multi-site assignments: the PM oversees all real sites, the Site
  // Engineer just one or two — matching Zen's "PM might have ten-plus, a
  // Site Engineer one to three" description.
  db.prepare('INSERT INTO user_site_assignments (user_id, site_id) VALUES (?, ?)').run(pm1Id, siteIds[0]);
  db.prepare('INSERT INTO user_site_assignments (user_id, site_id) VALUES (?, ?)').run(pm1Id, siteIds[1]);
  db.prepare('INSERT INTO user_site_assignments (user_id, site_id) VALUES (?, ?)').run(pm1Id, siteIds[2]);
  db.prepare('INSERT INTO user_site_assignments (user_id, site_id) VALUES (?, ?)').run(se1Id, siteIds[0]);

  console.log('Seeding workers...');
  const firstNames = ['Ravi', 'Suresh', 'Anil', 'Vikram', 'Manoj', 'Sanjay', 'Arjun', 'Rajesh', 'Amit', 'Pradeep', 'Vijay', 'Ramesh', 'Ganesh', 'Naveen', 'Ashok'];
  const lastNames = ['Kumar', 'Singh', 'Sharma', 'Yadav', 'Gupta', 'Reddy', 'Nair', 'Das', 'Rao', 'Joshi'];
  const typeNames = Object.keys(typeIds);
  const vendorChoices = [directVendorId, directVendorId, vendorAId, vendorBId]; // roughly half direct

  const insertWorker = db.prepare(
    `INSERT INTO workers (worker_code, name, worker_type_id, vendor_id, aadhar_number, site_id, wage_rate, overtime_multiplier, contact, status, skill_grade, verification_status, joined_date)
     VALUES (@worker_code, @name, @worker_type_id, @vendor_id, @aadhar_number, @site_id, @wage_rate, @overtime_multiplier, @contact, 'active', @skill_grade, @verification_status, @joined_date)`
  );
  const skillGrades = ['trainee', 'skilled', 'skilled', 'expert'];
  // Auto-generated Worker IDs, same "WRK-xxxx" convention nextWorkerCode()
  // uses in the real app — mirrors production numbering, not a separate
  // seed-only scheme.
  const nextWorkerCode = () => 'WRK-' + String(++workerCodeSeq).padStart(4, '0');
  let workerCodeSeq = 0;

  const workerIds = [];
  let count = 0;
  for (const siteId of siteIds) {
    const numWorkers = 8;
    for (let i = 0; i < numWorkers; i++) {
      count++;
      const name = `${firstNames[count % firstNames.length]} ${lastNames[count % lastNames.length]}`;
      const typeName = typeNames[count % typeNames.length];
      const vendorId = vendorChoices[count % vendorChoices.length];
      const wageRate = 60 + (count % 6) * 5; // hourly rate
      const aadhar = String(100000000000 + count * 137).slice(0, 12);
      const info = insertWorker.run({
        worker_code: nextWorkerCode(),
        name,
        worker_type_id: typeIds[typeName],
        vendor_id: vendorId,
        aadhar_number: aadhar,
        site_id: siteId,
        wage_rate: wageRate,
        overtime_multiplier: 1.5,
        contact: `9${String(700000000 + count).slice(0, 9)}`,
        skill_grade: skillGrades[count % skillGrades.length],
        // Roughly two-thirds already ID-verified by HR, the rest still pending — shows off both states.
        verification_status: count % 3 === 0 ? 'pending' : 'verified',
        joined_date: '2025-01-15',
      });
      workerIds.push({ id: info.lastInsertRowid, siteId });
    }
  }
  // Leave a couple of freshly-added workers unassigned in the pool, to show the workflow.
  const poolCount = 2;
  for (let i = 0; i < poolCount; i++) {
    count++;
    const name = `${firstNames[count % firstNames.length]} ${lastNames[count % lastNames.length]}`;
    const typeName = typeNames[count % typeNames.length];
    const vendorId = vendorChoices[count % vendorChoices.length];
    const aadhar = String(100000000000 + count * 137).slice(0, 12);
    insertWorker.run({
      worker_code: nextWorkerCode(),
      name,
      worker_type_id: typeIds[typeName],
      vendor_id: vendorId,
      aadhar_number: aadhar,
      site_id: 100,
      wage_rate: 65,
      overtime_multiplier: 1.5,
      contact: `9${String(700000000 + count).slice(0, 9)}`,
      skill_grade: 'skilled',
      // Freshly-added pool workers realistically haven't been verified yet.
      verification_status: 'pending',
      joined_date: new Date().toISOString().slice(0, 10),
    });
  }

  console.log('Seeding attendance for the last 7 days (hourly, with some leave/split-site examples)...');
  const insertAttendance = db.prepare(
    `INSERT INTO attendance (worker_id, site_id, date, hours_worked, leave_hours, overtime_hours, marked_by)
     VALUES (@worker_id, @site_id, @date, @hours, @leave, @ot, @marked_by)
     ON CONFLICT(worker_id, date, site_id) DO NOTHING`
  );
  const admin = auth.findUserByUsername('admin');
  for (let d = 6; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    for (const { id: workerId, siteId } of workerIds) {
      const roll = Math.random();
      let hours = 8;
      let leave = 0;
      let ot = 0;
      if (roll < 0.08) {
        hours = 0; // absent
      } else if (roll < 0.15) {
        hours = 4; // half day
      } else if (roll < 0.2) {
        hours = 6;
        leave = 2; // partial-day leave, signed off for the rest
      } else if (roll > 0.85) {
        ot = 2;
      }
      insertAttendance.run({ worker_id: workerId, site_id: siteId, date, hours, leave, ot, marked_by: admin.id });
    }
  }
  // One example split-site day: first worker works half the day at their home site,
  // then finishes the day at another site.
  if (workerIds.length > 0) {
    const w = workerIds[0];
    const otherSite = siteIds.find((s) => s !== w.siteId) || siteIds[0];
    const today = new Date().toISOString().slice(0, 10);
    insertAttendance.run({ worker_id: w.id, site_id: w.siteId, date: today, hours: 4, leave: 0, ot: 0, marked_by: admin.id });
    insertAttendance.run({ worker_id: w.id, site_id: otherSite, date: today, hours: 4, leave: 0, ot: 0, marked_by: admin.id });
  }

  console.log('Seed complete.');
  console.log('Login with: superadmin1/superadmin123, admin/admin123, hr/hr123, labormanager1/labor123, auditmanager1/audit123, pm1/pm123, se1/se123');
}

seed();
