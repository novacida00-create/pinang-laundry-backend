require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const midtransClient = require("midtrans-client");
const nodemailer = require("nodemailer");
const mysql = require("mysql2/promise");

const app = express();

// MySQL connection pool
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'defaultdb',
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_HOST && (process.env.DB_HOST.includes('aivencloud.com') || process.env.DB_HOST.includes('tidbcloud.com'))
    ? { rejectUnauthorized: false }
    : undefined,
});

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_PORT === "465",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

app.use(cors());
app.use(express.json());

// Serve built frontend
app.use(express.static(path.join(__dirname, "..", "pinang-laundry-frontend", "dist")));

// Snap API instance
const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// Create transaction & get Snap token
app.post("/api/midtrans/transaction", async (req, res) => {
  try {
    const { order_id, gross_amount, customer_details } = req.body;
    if (!order_id || !gross_amount) {
      return res.status(400).json({ error: "order_id and gross_amount required" });
    }
    const parameter = {
      transaction_details: { order_id, gross_amount },
      credit_card: { secure: true },
      customer_details: customer_details || { first_name: "Pelanggan", phone: "" },
    };
    const transaction = await snap.createTransaction(parameter);
    res.json({ snap_token: transaction.token, redirect_url: transaction.redirect_url });
  } catch (err) {
    console.error("Midtrans error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Check transaction status
app.get("/api/midtrans/status/:order_id", async (req, res) => {
  try {
    const status = await snap.transaction.status(req.params.order_id);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Webhook notification from Midtrans
app.post("/api/midtrans/notification", async (req, res) => {
  try {
    const notification = await snap.transaction.notification(req.body);
    const orderId = notification.order_id;
    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;
    console.log(`Order ${orderId}: ${transactionStatus} (${fraudStatus})`);
    if (transactionStatus === "capture" || transactionStatus === "settlement") {
      const orderCode = orderId.startsWith("QRIS-") ? orderId.replace("QRIS-", "") : null;
      if (orderCode) {
        await db.query(
          "UPDATE orders SET status = ?, payment = ?, payment_status = ?, paid_at = NOW() WHERE order_code = ? AND payment_status IS NULL",
          ["Selesai", "qris", "Lunas", orderCode]
        );
        console.log(`Order ${orderCode} marked as Lunas via webhook`);
      }
    } else if (["deny", "cancel", "expire"].includes(transactionStatus)) {
      console.log(`Payment FAILED for order ${orderId}`);
    } else if (transactionStatus === "pending") {
      console.log(`Payment PENDING for order ${orderId}`);
    }
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("Notification error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Verify and update payment status manually
app.post("/api/midtrans/verify-payment", async (req, res) => {
  try {
    const { order_code } = req.body;
    if (!order_code) return res.status(400).json({ error: "order_code required" });
    const orderId = "QRIS-" + order_code;
    const status = await snap.transaction.status(orderId);
    if (status.transaction_status === "capture" || status.transaction_status === "settlement") {
      await db.query(
        "UPDATE orders SET status = ?, payment = ?, payment_status = ?, paid_at = NOW() WHERE order_code = ? AND payment_status IS NULL",
        ["Selesai", "qris", "Lunas", order_code]
      );
      return res.json({ paid: true, transaction_status: status.transaction_status });
    }
    res.json({ paid: false, transaction_status: status.transaction_status, message: "Pembayaran belum dikonfirmasi Midtrans" });
  } catch (err) {
    if (err.message && err.message.includes("not found")) {
      return res.json({ paid: false, transaction_status: "not_found", message: "Belum ada transaksi QRIS untuk pesanan ini" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Core API instance for direct QRIS
const core = new midtransClient.CoreApi({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// Create QRIS transaction directly
app.post("/api/midtrans/qris", async (req, res) => {
  try {
    const { order_id, gross_amount, customer_details } = req.body;
    if (!order_id || !gross_amount) {
      return res.status(400).json({ error: "order_id and gross_amount required" });
    }
    const parameter = {
      payment_type: "qris",
      transaction_details: { order_id, gross_amount },
      item_details: [{ id: "laundry-1", price: gross_amount, quantity: 1, name: "Laundry" }],
      customer_details: customer_details || { first_name: "Pelanggan", phone: "" },
    };
    const result = await core.charge(parameter);
    const qrUrl = result.actions?.[0]?.url;
    res.json({ order_id, qr_url: qrUrl, transaction_status: result.transaction_status });
  } catch (err) {
    console.error("QRIS error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Email notification
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    if (!to || !subject || !html) {
      return res.status(400).json({ error: "to, subject, and html required" });
    }
    const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
    await transporter.sendMail({
      from: `"Pinang Laundry" <${process.env.SMTP_USER}>`,
      to,
      bcc: adminEmail,
      subject,
      html,
    });
    res.json({ status: "sent" });
  } catch (err) {
    console.error("Email error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===================== LAYANAN =====================

app.get("/api/layanan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM layanan ORDER BY no");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/layanan", async (req, res) => {
  try {
    const { name, jenis, harga, waktu, status } = req.body;
    const [max] = await db.query("SELECT COALESCE(MAX(no), 0) + 1 AS next_no FROM layanan");
    const no = max[0].next_no;
    const [result] = await db.query(
      "INSERT INTO layanan (no, name, jenis, harga, waktu, status) VALUES (?, ?, ?, ?, ?, ?)",
      [no, name, jenis, harga, waktu, status || "Aktif"]
    );
    res.json({ id: result.insertId, no });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/layanan/:id", async (req, res) => {
  try {
    const { name, jenis, harga, waktu, status } = req.body;
    await db.query(
      "UPDATE layanan SET name = ?, jenis = ?, harga = ?, waktu = ?, status = ? WHERE id = ?",
      [name, jenis, harga, waktu, status, req.params.id]
    );
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/layanan/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM layanan WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== PELANGGAN =====================

app.get("/api/pelanggan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM pelanggan ORDER BY id");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pelanggan", async (req, res) => {
  try {
    const { name, email, phone, address, order_count, status } = req.body;
    const [result] = await db.query(
      "INSERT INTO pelanggan SET ?",
      { name, email: email || "", phone: phone || "", address: address || "", order_count: order_count || 0, status: status || "Aktif" }
    );
    res.json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/pelanggan/:id", async (req, res) => {
  try {
    const { name, email, phone, address, order_count, status } = req.body;
    await db.query(
      "UPDATE pelanggan SET name = ?, email = ?, phone = ?, address = ?, order_count = ?, status = ? WHERE id = ?",
      [name, email, phone, address, order_count, status, req.params.id]
    );
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/pelanggan/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM pelanggan WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== KARYAWAN =====================

app.get("/api/karyawan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM karyawan ORDER BY no");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/karyawan", async (req, res) => {
  try {
    const { name, role, phone, order_count, status } = req.body;
    const [max] = await db.query("SELECT COALESCE(MAX(no), 0) + 1 AS next_no FROM karyawan");
    const no = max[0].next_no;
    const [result] = await db.query(
      "INSERT INTO karyawan (no, name, role, phone, order_count, status) VALUES (?, ?, ?, ?, ?, ?)",
      [no, name, role, phone, order_count || 0, status || "Aktif"]
    );
    res.json({ id: result.insertId, no });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/karyawan/:id", async (req, res) => {
  try {
    const { name, role, phone, order_count, status } = req.body;
    await db.query(
      "UPDATE karyawan SET name = ?, role = ?, phone = ?, order_count = ?, status = ? WHERE id = ?",
      [name, role, phone, order_count, status, req.params.id]
    );
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/karyawan/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM karyawan WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/karyawan/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    const [rows] = await db.query(
      "SELECT id, name, role, phone, email, status FROM karyawan WHERE name = ? AND password = ?",
      [username, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    if (rows[0].status !== 'Aktif') {
      return res.status(403).json({ error: "Akun tidak aktif" });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== ORDERS =====================

app.get("/api/orders", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const [result] = await db.query("INSERT INTO orders SET ?", req.body);
    const [rows] = await db.query("SELECT * FROM orders WHERE id = ?", [result.insertId]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/orders/:id", async (req, res) => {
  try {
    await db.query("UPDATE orders SET ? WHERE id = ?", [req.body, req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM orders WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    await db.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== LAPORAN =====================

app.get("/api/laporan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM laporan ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/laporan", async (req, res) => {
  try {
    const [result] = await db.query("INSERT INTO laporan SET ?", req.body);
    res.json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/laporan/:id", async (req, res) => {
  try {
    await db.query("UPDATE laporan SET ? WHERE id = ?", [req.body, req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/laporan/:id", async (req, res) => {
  try {
    await db.query("DELETE FROM laporan WHERE id = ?", [req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== PENGATURAN =====================

app.get("/api/pengaturan", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM pengaturan WHERE id = 1");
    const data = rows[0] || {};
    const map = {
      nama_toko: "namaToko",
      alamat: "alamat",
      telepon: "telepon",
      nama_admin: "namaAdmin",
      jam_buka: "jamBuka",
      jam_tutup: "jamTutup",
      notif_email: "notifEmail",
      notif_sms: "notifSMS",
      auto_reminder: "autoReminder",
      fonnte_token: "fonnteToken",
      wa_admin: "waAdmin",
      wa_notif: "waNotif",
      id: "id",
      created_at: "created_at",
      updated_at: "updated_at",
    };
    const result = {};
    for (const [dbCol, frontendKey] of Object.entries(map)) {
      if (data[dbCol] !== undefined) result[frontendKey] = data[dbCol];
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/pengaturan", async (req, res) => {
  try {
    const body = { ...req.body };
    // Map camelCase frontend keys to snake_case DB columns
    const map = {
      namaToko: "nama_toko",
      namaAdmin: "nama_admin",
      jamBuka: "jam_buka",
      jamTutup: "jam_tutup",
      notifEmail: "notif_email",
      notifSMS: "notif_sms",
      autoReminder: "auto_reminder",
      fonnteToken: "fonnte_token",
      waAdmin: "wa_admin",
      waNotif: "wa_notif",
    };
    for (const [frontend, db] of Object.entries(map)) {
      if (body[frontend] !== undefined) {
        body[db] = body[frontend];
        delete body[frontend];
      }
    }
    await db.query("UPDATE pengaturan SET ? WHERE id = 1", body);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== CUSTOMERS =====================

app.get("/api/customers", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, name, username, email, phone, address, total_orders FROM customers"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customers/register", async (req, res) => {
  try {
    const { name, username, email, password, phone, address } = req.body;
    if (!name || !username || !email || !password) {
      return res.status(400).json({ error: "name, username, email, and password required" });
    }
    const [existing] = await db.query("SELECT id FROM customers WHERE email = ?", [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email already registered" });
    }
    const [result] = await db.query(
      "INSERT INTO customers (name, username, email, password, phone, address) VALUES (?, ?, ?, ?, ?, ?)",
      [name, username, email, password, phone || "", address || ""]
    );
    res.json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/customers/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }
    const [rows] = await db.query(
      "SELECT id, name, username, email, phone, address, total_orders FROM customers WHERE (email = ? OR username = ?) AND password = ?",
      [email, email, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/customers/reset-password", async (req, res) => {
  try {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) {
      return res.status(400).json({ error: "username and newPassword required" });
    }
    const [result] = await db.query("UPDATE customers SET password = ? WHERE username = ?", [newPassword, username]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Username not found" });
    }
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/customers/:id", async (req, res) => {
  try {
    await db.query("UPDATE customers SET ? WHERE id = ?", [req.body, req.params.id]);
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== TESTIMONIALS =====================

app.get("/api/testimonials", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM testimonials ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/testimonials", async (req, res) => {
  try {
    const { name, text, rating, customer_id } = req.body;
    const [result] = await db.query(
      "INSERT INTO testimonials SET ?",
      { name: name || "", text: text || "", rating: rating || 5, customer_id: customer_id || null }
    );
    res.json({ id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== USERS =====================

app.get("/api/users", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT id, name, email, role FROM users");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password required" });
    }
    const [rows] = await db.query(
      "SELECT id, name, email, role FROM users WHERE email = ? AND password = ?",
      [email, password]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback - serve index.html for all non-API routes
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  res.sendFile(path.join(__dirname, "..", "pinang-laundry-frontend", "dist", "index.html"));
});

if (process.env.VERCEL !== "1") {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`Midtrans mode: ${process.env.MIDTRANS_IS_PRODUCTION === "true" ? "PRODUCTION" : "SANDBOX"}`);
  });
}

module.exports = app;
