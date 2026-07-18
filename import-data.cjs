const XLSX = require('xlsx');
const mysql = require('mysql2/promise');

async function main() {
  const wb = XLSX.readFile('C:\\Laundry\\Data Laundry.xlsx');
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, skipHidden: true });

  const rows = [];
  for (let i = 2; i < raw.length; i++) {
    const r = raw[i];
    if (!r || !r[0] || r[0] === 'No') continue;
    rows.push({
      no: Number(r[0]),
      tanggal: String(r[1] || ''),
      nama: String(r[2] || '').trim(),
      email: String(r[3] || '').trim(),
      phone: String(r[4] || '').trim(),
      address: String(r[5] || '').trim(),
      layanan: String(r[6] || '').trim(),
      jumlah: Number(r[7]) || 0,
      satuan: String(r[8] || '').trim(),
      harga_per_unit: Number(r[9]) || 0,
      total: Number(r[10]) || 0,
      metode: String(r[11] || '').trim(),
      status: String(r[12] || '').trim(),
    });
  }

  console.log('Total transaksi: ' + rows.length);

  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3306,
    user: 'root',
    database: 'pinang_laundry',
  });

  const pelangganMap = new Map();
  for (const r of rows) {
    if (!pelangganMap.has(r.nama)) {
      pelangganMap.set(r.nama, { name: r.nama, email: r.email, phone: r.phone, address: r.address });
    }
  }

  console.log('Inserting ' + pelangganMap.size + ' pelanggan...');
  for (const [name, p] of pelangganMap) {
    await conn.query(
      'INSERT IGNORE INTO pelanggan (name, email, phone, address, order_count, status) VALUES (?, ?, ?, ?, 0, ?)',
      [p.name, p.email, p.phone, p.address, 'Aktif']
    );
  }

  const orderCountMap = new Map();
  for (const r of rows) {
    orderCountMap.set(r.nama, (orderCountMap.get(r.nama) || 0) + 1);
  }
  for (const [name, count] of orderCountMap) {
    await conn.query('UPDATE pelanggan SET order_count = ? WHERE name = ?', [count, name]);
  }

  const layananMap = new Map();
  for (const r of rows) {
    if (!layananMap.has(r.layanan)) {
      layananMap.set(r.layanan, { name: r.layanan, harga: r.harga_per_unit, satuan: r.satuan });
    }
  }

  console.log('Updating ' + layananMap.size + ' layanan...');
  let no = 1;
  for (const [name, l] of layananMap) {
    const [existing] = await conn.query('SELECT id FROM layanan WHERE name = ?', [name]);
    if (existing.length > 0) {
      await conn.query('UPDATE layanan SET harga = ?, waktu = ? WHERE id = ?', [String(l.harga), '24 jam', existing[0].id]);
    } else {
      await conn.query(
        'INSERT INTO layanan (no, name, jenis, harga, waktu, status) VALUES (?, ?, ?, ?, ?, ?)',
        [no, name, 'Kiloan', String(l.harga), '24 jam', 'Aktif']
      );
      no++;
    }
  }

  console.log('Inserting ' + rows.length + ' orders...');
  for (const r of rows) {
    const orderCode = 'ORD-' + String(r.no).padStart(4, '0');
    const monthMap = {
      'Januari': '01', 'Februari': '02', 'Maret': '03', 'April': '04',
      'Mei': '05', 'Juni': '06', 'Juli': '07', 'Agustus': '08',
      'September': '09', 'Oktober': '10', 'November': '11', 'Desember': '12'
    };

    let createdAt = '2026-03-01 10:00:00';
    if (r.tanggal.includes('/')) {
      const parts = r.tanggal.split('/');
      if (parts.length === 3) {
        createdAt = parts[2] + '-' + parts[1].padStart(2, '0') + '-' + parts[0].padStart(2, '0') + ' 10:00:00';
      }
    } else if (monthMap[r.tanggal]) {
      createdAt = '2026-' + monthMap[r.tanggal] + '-15 10:00:00';
    }

    await conn.query(
      'INSERT IGNORE INTO orders (order_code, customer_name, email, phone, address, service_name, weight, price, total, status, payment, payment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orderCode, r.nama, r.email, r.phone, r.address, r.layanan, r.jumlah, r.harga_per_unit, r.total, r.status, r.metode.toLowerCase(), 'Lunas', createdAt]
    );
  }

  console.log('Inserting laporan...');
  for (const r of rows) {
    const orderCode = 'ORD-' + String(r.no).padStart(4, '0');
    let tanggal = r.tanggal;
    if (r.tanggal.includes('/')) {
      const parts = r.tanggal.split('/');
      if (parts.length === 3) {
        tanggal = parts[2] + '-' + parts[1].padStart(2, '0') + '-' + parts[0].padStart(2, '0');
      }
    }

    const [orderRows] = await conn.query('SELECT id FROM orders WHERE order_code = ?', [orderCode]);
    const orderId = orderRows.length > 0 ? orderRows[0].id : null;

    await conn.query(
      'INSERT INTO laporan (order_id, tanggal, pelanggan, layanan, berat, harga, total, delivery_mode, status, payment, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [orderId, tanggal, r.nama, r.layanan, r.jumlah + ' ' + r.satuan, String(r.harga_per_unit), String(r.total), 'mandiri', r.status, r.metode.toLowerCase(), 'Lunas']
    );
  }

  console.log('Creating customer accounts...');
  const uniqueNames = [...new Set(rows.map(r => r.nama))];
  for (const name of uniqueNames) {
    const r = rows.find(x => x.nama === name);
    const username = name.replace(/\s+/g, '').toUpperCase();
    await conn.query(
      'INSERT IGNORE INTO customers (name, username, email, password, phone, address) VALUES (?, ?, ?, ?, ?, ?)',
      [name, username, r.email || username.toLowerCase() + '@gmail.com', '123456', r.phone, r.address]
    );
  }

  const [counts] = await conn.query("SELECT 'pelanggan' AS t, COUNT(*) AS c FROM pelanggan UNION ALL SELECT 'orders', COUNT(*) FROM orders UNION ALL SELECT 'layanan', COUNT(*) FROM layanan UNION ALL SELECT 'laporan', COUNT(*) FROM laporan UNION ALL SELECT 'customers', COUNT(*) FROM customers");
  console.log('\n=== RESULT ===');
  counts.forEach(function(r) { console.log(r.t + ': ' + r.c); });

  await conn.end();
  console.log('\nDone!');
}

main().catch(function(err) { console.error(err); process.exit(1); });
