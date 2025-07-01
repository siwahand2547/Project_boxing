const mysql = require('mysql2');

const db = mysql.createConnection({
  host: '127.0.0.1',    // ใช้ 127.0.0.1 แทน localhost
  user: 'root',         // ตามค่า XAMPP ค่าเริ่มต้นคือ root
  password: '',         // ถ้า XAMPP ไม่มีรหัสผ่าน ให้เว้นว่าง
  database: 'testdb'    // ชื่อฐานข้อมูลที่คุณสร้าง
});

db.connect(err => {
  if (err) {
    console.error('MySQL connection error:', err);
    return;
  }
  console.log('Connected to MySQL!');
});

module.exports = db;
