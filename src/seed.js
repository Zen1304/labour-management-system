'use strict';
const { pool, nowSqliteStyle, ready } = require('./db');
const auth = require('./auth');

async function seed() {
  await ready;

  const { rows: userCountRows } = await pool.query('SELECT COUNT(*) c FROM users');
  const userCount = Number(userCountRows[0].c);
  if (userCount > 0) {
    console.log('Database already seeded. Skipping.');
    return;
  }

  console.log('Seeding the Unassigned Pool (site 100) + real sites...');
  await pool.query('INSERT INTO sites (id, name, location) VALUES (100, $1, $2)', [
    'Unassigned Pool',
    'System default — reassign workers from here',
  ]);
  const siteIds = [];
  for (const name of ['Site 101 - North Yard', 'Site 102 - Downtown', 'Site 103 - Warehouse']) {
    const { rows } = await pool.query('INSERT INTO sites (name, location) VALUES ($1, $2) RETURNING id', [name, 'India']);
    siteIds.push(rows[0].id);
  }
  // Show off the status field: one site on hold, one wrapped up.
  await pool.query('UPDATE sites SET status = $1 WHERE id = $2', ['on_hold', siteIds[1]]);
  const { rows: site4Rows } = await pool.query(
    'INSERT INTO sites (name, location, status) VALUES ($1, $2, $3) RETURNING id',
    ['Site 104 - Riverside (wrapped up)', 'India', 'completed']
  );
  const site4Id = site4Rows[0].id; // eslint-disable-line no-unused-vars

  console.log('Seeding vendors...');
  // Vendor codes are auto-generated in the real app (see nextVendorCode() in
  // app.js) — the built-in Direct vendor gets a fixed "B0001"-style code and
  // regular vendors get sequential "V0001"-style codes, so the seed mirrors
  // that same convention rather than inventing its own.
  const { rows: directVendorRows } = await pool.query(
    `INSERT INTO vendors (vendor_code, name, contact, email, address, is_direct, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
    ['B0001', 'Bilara (Direct)', '9800000001', 'hr@bilaragroup.example', 'BilaraGroup HQ, India', nowSqliteStyle()]
  );
  const directVendorId = directVendorRows[0].id;
  const { rows: vendorARows } = await pool.query(
    `INSERT INTO vendors (vendor_code, name, contact, whatsapp, email, address, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    ['V0001', 'Shree Labour Suppliers', '9812345001', '9812345009', 'contact@shreelabour.example', 'MG Road, Bengaluru', nowSqliteStyle()]
  );
  const vendorAId = vendorARows[0].id;
  const { rows: vendorBRows } = await pool.query(
    `INSERT INTO vendors (vendor_code, name, contact, email, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['V0002', 'Om Manpower Services', '9812345002', 'ops@ommanpower.example', nowSqliteStyle()]
  );
  const vendorBId = vendorBRows[0].id;

  console.log('Seeding worker types...');
  const typeIds = {};
  for (const name of ['Mason', 'Helper', 'Tile Worker', 'Electrician', 'Plumber', 'Welder', 'Carpenter']) {
    const { rows } = await pool.query('INSERT INTO worker_types (name) VALUES ($1) RETURNING id', [name]);
    typeIds[name] = rows[0].id;
  }

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
  await auth.createUser({ username: 'superadmin1', password: 'superadmin123', name: 'Neha Kapoor', role: 'super_admin', contact: '9800000009' });
  await auth.createUser({ username: 'admin', password: 'admin123', name: 'Asha Verma', role: 'admin', contact: '9800000010' });
  await auth.createUser({ username: 'hr', password: 'hr123', name: 'Rohit Mehta', role: 'hr', contact: '9800000011' });
  await auth.createUser({ username: 'labormanager1', password: 'labor123', name: 'Manish Bhatt', role: 'labor_manager', contact: '9800000014' });
  await auth.createUser({ username: 'auditmanager1', password: 'audit123', name: 'Priya Chawla', role: 'audit_manager', contact: '9800000015' });
  const pm1Id = await auth.createUser({ username: 'pm1', password: 'pm123', name: 'Farah Sheikh', role: 'project_manager', contact: '9800000018' });
  const se1Id = await auth.createUser({ username: 'se1', password: 'se123', name: 'Karan Vora', role: 'site_engineer', contact: '9800000019' });
  // Demo multi-site assignments: the PM oversees all real sites, the Site
  // Engineer just one or two — matching Zen's "PM might have ten-plus, a
  // Site Engineer one to three" description.
  await pool.query('INSERT INTO user_site_assignments (user_id, site_id, created_at) VALUES ($1, $2, $3)', [pm1Id, siteIds[0], nowSqliteStyle()]);
  await pool.query('INSERT INTO user_site_assignments (user_id, site_id, created_at) VALUES ($1, $2, $3)', [pm1Id, siteIds[1], nowSqliteStyle()]);
  await pool.query('INSERT INTO user_site_assignments (user_id, site_id, created_at) VALUES ($1, $2, $3)', [pm1Id, siteIds[2], nowSqliteStyle()]);
  await pool.query('INSERT INTO user_site_assignments (user_id, site_id, created_at) VALUES ($1, $2, $3)', [se1Id, siteIds[0], nowSqliteStyle()]);

  console.log('Seeding workers...');
  const firstNames = ['Ravi', 'Suresh', 'Anil', 'Vikram', 'Manoj', 'Sanjay', 'Arjun', 'Rajesh', 'Amit', 'Pradeep', 'Vijay', 'Ramesh', 'Ganesh', 'Naveen', 'Ashok'];
  const lastNames = ['Kumar', 'Singh', 'Sharma', 'Yadav', 'Gupta', 'Reddy', 'Nair', 'Das', 'Rao', 'Joshi'];
  const typeNames = Object.keys(typeIds);
  const vendorChoices = [directVendorId, directVendorId, vendorAId, vendorBId]; // roughly half direct

  const skillGrades = ['trainee', 'skilled', 'skilled', 'expert'];
  // Auto-generated Worker IDs, matching the "W00001" convention
  // nextWorkerCode() uses in the real app.
  let workerCodeSeq = 0;
  const nextWorkerCode = () => 'W' + String(++workerCodeSeq).padStart(5, '0');

  async function insertWorker(w) {
    const { rows } = await pool.query(
      `INSERT INTO workers (worker_code, name, worker_type_id, vendor_id, aadhar_number, site_id, wage_rate, overtime_multiplier, contact, status, skill_grade, verification_status, joined_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12, $13) RETURNING id`,
      [
        w.worker_code,
        w.name,
        w.worker_type_id,
        w.vendor_id,
        w.aadhar_number,
        w.site_id,
        w.wage_rate,
        w.overtime_multiplier,
        w.contact,
        w.skill_grade,
        w.verification_status,
        w.joined_date,
        nowSqliteStyle(),
      ]
    );
    return rows[0].id;
  }

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
      const id = await insertWorker({
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
      workerIds.push({ id, siteId });
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
    await insertWorker({
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
  async function insertAttendance(a) {
    await pool.query(
      `INSERT INTO attendance (worker_id, site_id, date, hours_worked, leave_hours, overtime_hours, marked_by, marked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (worker_id, date, site_id) DO NOTHING`,
      [a.worker_id, a.site_id, a.date, a.hours, a.leave, a.ot, a.marked_by, nowSqliteStyle()]
    );
  }
  const admin = await auth.findUserByUsername('admin');
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
      await insertAttendance({ worker_id: workerId, site_id: siteId, date, hours, leave, ot, marked_by: admin.id });
    }
  }
  // One example split-site day: first worker works half the day at their home site,
  // then finishes the day at another site.
  if (workerIds.length > 0) {
    const w = workerIds[0];
    const otherSite = siteIds.find((s) => s !== w.siteId) || siteIds[0];
    const today = new Date().toISOString().slice(0, 10);
    await insertAttendance({ worker_id: w.id, site_id: w.siteId, date: today, hours: 4, leave: 0, ot: 0, marked_by: admin.id });
    await insertAttendance({ worker_id: w.id, site_id: otherSite, date: today, hours: 4, leave: 0, ot: 0, marked_by: admin.id });
  }

  console.log('Seed complete.');
  console.log('Login with: superadmin1/superadmin123, admin/admin123, hr/hr123, labormanager1/labor123, auditmanager1/audit123, pm1/pm123, se1/se123');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
