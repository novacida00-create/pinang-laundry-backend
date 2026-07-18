require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    ssl: { rejectUnauthorized: false },
  });

  console.log("Connected to Aiven MySQL!");

  const stmts = [
    // -- Admin users
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    // -- Customer accounts (auth)
    `CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      username VARCHAR(100) NOT NULL UNIQUE,
      email VARCHAR(100) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      phone VARCHAR(50) DEFAULT '',
      address TEXT,
      total_orders INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    // -- Customer records (CRM)
    `CREATE TABLE IF NOT EXISTS pelanggan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) DEFAULT '',
      phone VARCHAR(50) DEFAULT '',
      address TEXT,
      order_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'Aktif',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    // -- Services
    `CREATE TABLE IF NOT EXISTS layanan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      no INT DEFAULT 0,
      name VARCHAR(100) NOT NULL,
      jenis VARCHAR(50) DEFAULT '',
      harga VARCHAR(20) DEFAULT '0',
      waktu VARCHAR(50) DEFAULT '',
      status VARCHAR(20) DEFAULT 'Aktif',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    // -- Orders
    `CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(50) NOT NULL UNIQUE,
      customer_name VARCHAR(100) NOT NULL,
      email VARCHAR(100) DEFAULT '',
      phone VARCHAR(50) DEFAULT '',
      address TEXT,
      service_name VARCHAR(100) DEFAULT '',
      weight DECIMAL(10,2) DEFAULT 0,
      price INT DEFAULT 0,
      biaya_cuci INT DEFAULT 0,
      ongkir INT DEFAULT 0,
      delivery_mode VARCHAR(20) DEFAULT 'mandiri',
      jarak VARCHAR(20) DEFAULT NULL,
      total INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'Menunggu',
      payment VARCHAR(20) DEFAULT NULL,
      payment_status VARCHAR(20) DEFAULT NULL,
      paid_at DATETIME DEFAULT NULL,
      customer_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,

    // -- Reports
    `CREATE TABLE IF NOT EXISTS laporan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT DEFAULT NULL,
      tanggal VARCHAR(50) DEFAULT '',
      pelanggan VARCHAR(100) DEFAULT '',
      layanan VARCHAR(100) DEFAULT '',
      berat VARCHAR(20) DEFAULT '',
      harga VARCHAR(20) DEFAULT '',
      total VARCHAR(20) DEFAULT '',
      ongkir VARCHAR(20) DEFAULT '',
      delivery_mode VARCHAR(20) DEFAULT '',
      status VARCHAR(20) DEFAULT 'Baru',
      payment_status VARCHAR(20) DEFAULT NULL,
      payment VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // -- Employees
    `CREATE TABLE IF NOT EXISTS karyawan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      no INT DEFAULT 0,
      name VARCHAR(100) NOT NULL,
      role VARCHAR(50) DEFAULT '',
      phone VARCHAR(50) DEFAULT '',
      order_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'Aktif',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    // -- Settings (single row)
    `CREATE TABLE IF NOT EXISTS pengaturan (
      id INT DEFAULT 1,
      nama_toko VARCHAR(100) DEFAULT 'Pinang Laundry',
      alamat TEXT,
      telepon VARCHAR(50) DEFAULT '',
      nama_admin VARCHAR(100) DEFAULT 'Alex',
      jam_buka VARCHAR(10) DEFAULT '07:00',
      jam_tutup VARCHAR(10) DEFAULT '21:00',
      notif_email BOOLEAN DEFAULT FALSE,
      notif_sms BOOLEAN DEFAULT FALSE,
      auto_reminder BOOLEAN DEFAULT FALSE,
      fonnte_token VARCHAR(255) DEFAULT '',
      wa_admin VARCHAR(50) DEFAULT '',
      wa_notif BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB`,

    // -- Testimonials
    `CREATE TABLE IF NOT EXISTS testimonials (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) DEFAULT '',
      text TEXT,
      rating INT DEFAULT 5,
      customer_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    // -- QRIS merchant data
    `CREATE TABLE IF NOT EXISTS qris_merchant (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
  ];

  for (const stmt of stmts) {
    try {
      await conn.query(stmt);
      const name = stmt.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1] || "?";
      console.log("OK:", name);
    } catch (err) {
      console.error("ERR:", err.message);
    }
  }

  // Seed data
  const seeds = [
    `INSERT IGNORE INTO users (name, email, password, role) VALUES ('Admin', 'admin@laundry.com', '123456', 'admin')`,
    `INSERT IGNORE INTO pengaturan (id, nama_toko, alamat, telepon, nama_admin, jam_buka, jam_tutup, notif_email, notif_sms, auto_reminder)
     VALUES (1, 'Pinang Laundry', 'Jl. Pinang Raya, Margonda Depok', '0895-4293-50001', 'Alex', '07:00', '21:00', FALSE, FALSE, FALSE)`,
    `INSERT IGNORE INTO layanan (no, name, jenis, harga, waktu, status) VALUES
     (1, 'Cuci Kiloan', 'Kiloan', '6000', '24 jam', 'Aktif'),
     (2, 'Express', 'Express', '15000', '4 jam', 'Aktif'),
     (3, 'Cuci Karpet', 'Spesial', '50000', '48 jam', 'Aktif'),
     (4, 'Cuci Sepatu', 'Spesial', '30000', '24 jam', 'Tidak Aktif'),
     (5, 'Cuci Boneka', 'Satuan', '10000', '24 jam', 'Aktif'),
     (6, 'Cuci Jaket', 'Kiloan', '12000', '24 jam', 'Aktif'),
     (7, 'Cuci Jas', 'Satuan', '35000', '48 jam', 'Aktif'),
     (8, 'Setrika Saja', 'Kiloan', '5000', '6 jam', 'Aktif'),
     (9, 'Cuci Setrika', 'Kiloan', '12000', '24 jam', 'Aktif')`,
    `INSERT IGNORE INTO karyawan (no, name, role, phone, order_count, status) VALUES
     (1, 'Siti Aisyah', 'Kasir', '0812-3456-7890', 120, 'Aktif'),
     (2, 'Ahmad Rizki', 'Admin', '0813-9876-5432', 85, 'Aktif'),
     (3, 'Dewi Sartika', 'Staff Laundry', '0821-6543-2109', 200, 'Aktif'),
     (4, 'Bambang', 'Delivery', '0856-7890-1234', 150, 'Aktif')`,
  ];

  console.log("\n--- Seeding data ---");
  for (const seed of seeds) {
    try {
      await conn.query(seed);
      const label = seed.substring(0, 60);
      console.log("OK:", label);
    } catch (err) {
      if (err.code === "ER_DUP_ENTRY") {
        console.log("SKIP (already exists):", seed.substring(0, 60));
      } else {
        console.error("ERR:", err.message);
      }
    }
  }

  // Verify
  const [tables] = await conn.query("SHOW TABLES");
  console.log("\n=== Tables in defaultdb ===");
  for (const row of tables) {
    const val = Object.values(row)[0];
    const [count] = await conn.query(`SELECT COUNT(*) AS cnt FROM \`${val}\``);
    console.log(`  ${val} (${count[0].cnt} rows)`);
  }

  await conn.end();
  console.log("\nDone!");
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
