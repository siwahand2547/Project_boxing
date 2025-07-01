const mysql = require('mysql2');

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', // ถ้าไม่มีรหัสผ่าน
  database: 'project_boxing'
});

db.connect(err => {
  if (err) {
    console.error('❌ Error connecting to DB:', err);
  } else {
    console.log('✅ Connected to MySQL DB');
  }
});

module.exports = db;
