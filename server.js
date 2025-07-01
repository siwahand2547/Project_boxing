const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// หน้า Home
app.get('/', (req, res) => {
  res.render('index');
});

// แสดงรายชื่อผู้ใช้
app.get('/users', (req, res) => {
  db.query('SELECT * FROM users', (err, results) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database error');
    }
    res.render('users', { users: results });
  });
});

// ฟอร์มเพิ่มผู้ใช้
app.get('/users/add', (req, res) => {
  res.render('addUser');
});

// เพิ่มผู้ใช้ใหม่
app.post('/users/add', (req, res) => {
  const { name, email } = req.body;
  db.query('INSERT INTO users (name, email) VALUES (?, ?)', [name, email], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database insert error');
    }
    res.redirect('/users');
  });
});

// ลบผู้ใช้ (POST)
app.post('/users/delete/:id', (req, res) => {
  const userId = req.params.id;
  db.query('DELETE FROM users WHERE id = ?', [userId], (err) => {
    if (err) {
      console.error(err);
      return res.status(500).send('Database delete error');
    }
    res.redirect('/users');
  });
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});

// แสดงฟอร์มแก้ไขข้อมูล
app.get('/users/edit/:id', (req, res) => {
    const userId = req.params.id;
    db.query('SELECT * FROM users WHERE id = ?', [userId], (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Database error');
      }
      if (results.length === 0) {
        return res.status(404).send('User not found');
      }
      res.render('editUser', { user: results[0] });
    });
  });
  
  // รับข้อมูลจากฟอร์มแก้ไขและอัปเดตฐานข้อมูล
  app.post('/users/edit/:id', (req, res) => {
    const userId = req.params.id;
    const { name, email } = req.body;
  
    db.query('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, userId], (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('Database update error');
      }
      res.redirect('/users');
    });
  });