// server.js
const express = require('express');
const http = require('http');
const path = require('path');

const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');


const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const db = require('./db');
// middleware
const multer = require('multer');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });
const fs = require('fs');

let portCOM4, portCOM5;
let isCOM4Connected = false;
let isCOM5Connected = false;

let portCOM6;
let isCOM6Connected = false;


// ฟังก์ชันตั้งค่า Parser อ่านข้อมูลจาก COM ports
function setupParser(port, label) {
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    parser.on('data', (data) => {
      console.log(`${label} data:`, data);
      io.emit('btData', { port: label, data }); // ส่งข้อมูล realtime ไป client ผ่าน socket.io
    });
  }
portCOM6 = new SerialPort({ path: 'COM6', baudRate: 115200 }, (err) => {
    if (err) return console.error('Error opening COM6:', err);
    setupParser(portCOM6);
  });

// Home
app.get('/', (req, res) => res.redirect('/fighters'));

// --------- Fighters CRUD ---------
app.get('/fighters', (req, res) => {
  db.query('SELECT * FROM fighters', (err, results) => {
    if (err) return res.status(500).send('DB Error');
    res.render('fighters', { fighters: results });
  });
});

app.get('/fighters/add', (req, res) => res.render('addFighter'));


app.get('/fighters/edit/:id', (req, res) => {
  db.query('SELECT * FROM fighters WHERE id = ?', [req.params.id], (err, results) => {
    if (err || results.length === 0) return res.status(404).send('Not found');
    res.render('editFighter', { fighter: results[0] });
  });
});

app.post('/fighters/edit/:id', (req, res) => {
  const { name, camp, weight_class } = req.body;
  db.query(
    'UPDATE fighters SET name = ?, camp = ?, weight_class = ? WHERE id = ?',
    [name, camp, weight_class, req.params.id],
    err => {
      if (err) return res.status(500).send('Update error');
      res.redirect('/fighters');
    }
  );
});

app.post('/fighters/delete/:id', (req, res) => {
  db.query('DELETE FROM fighters WHERE id = ?', [req.params.id], err => {
    if (err) return res.status(500).send('Delete error');
    res.redirect('/fighters');
  });
});

// --------- Fights CRUD ---------
app.get('/fights', (req, res) => {
  const sql = `
    SELECT f.id, f.fight_date, f.description,
           a.name AS fighter1, b.name AS fighter2, w.name AS winner
    FROM fights f
    JOIN fighters a ON f.fighter1_id = a.id
    JOIN fighters b ON f.fighter2_id = b.id
    LEFT JOIN fighters w ON f.winner_id = w.id
    ORDER BY f.fight_date DESC`;
  db.query(sql, (err, results) => {
    if (err) return res.status(500).send('DB error');
    res.render('fights', { fights: results });
  });
});


app.get('/fights/edit/:id', (req, res) => {
  const fightId = req.params.id;
  db.query('SELECT * FROM fights WHERE id = ?', [fightId], (err, results) => {
    if (err || results.length === 0) return res.status(404).send('Not found');
    const fight = results[0];
    db.query('SELECT * FROM fighters', (err, fighters) => {
      if (err) return res.status(500).send('DB error');
      res.render('editFight', { fight, fighters });
    });
  });
});

app.post('/fights/edit/:id', (req, res) => {
  const { fighter1_id, fighter2_id, winner_id, fight_date, description } = req.body;
  db.query(
    'UPDATE fights SET fighter1_id=?, fighter2_id=?, winner_id=?, fight_date=?, description=? WHERE id=?',
    [fighter1_id, fighter2_id, winner_id || null, fight_date, description, req.params.id],
    err => {
      if (err) return res.status(500).send('Update error');
      res.redirect('/fights');
    }
  );
});

app.post('/fights/delete/:id', (req, res) => {
  db.query('DELETE FROM fights WHERE id = ?', [req.params.id], err => {
    if (err) return res.status(500).send('Delete error');
    res.redirect('/fights');
  });
});

// 🔍 นักมวยรายบุคคลพร้อมประวัติการชก
app.get('/fighters/profile/:id', (req, res) => {
    const fighterId = req.params.id;
    const fighterQuery = 'SELECT * FROM fighters WHERE id = ?';
    const winQuery = `
      SELECT f.fight_date, f.description, a.name AS opponent
      FROM fights f
      JOIN fighters a ON a.id = IF(f.fighter1_id = ?, f.fighter2_id, f.fighter1_id)
      WHERE f.winner_id = ?`;
    const loseQuery = `
      SELECT f.fight_date, f.description, a.name AS opponent
      FROM fights f
      JOIN fighters a ON a.id = IF(f.fighter1_id = ?, f.fighter2_id, f.fighter1_id)
      WHERE f.winner_id != ? AND (f.fighter1_id = ? OR f.fighter2_id = ?)`;
  
    db.query(fighterQuery, [fighterId], (err, fighterResult) => {
      if (err || fighterResult.length === 0) return res.status(404).send('Fighter not found');
      const fighter = fighterResult[0];
      db.query(winQuery, [fighterId, fighterId], (err, wins) => {
        if (err) return res.status(500).send('Win query error');
        db.query(loseQuery, [fighterId, fighterId, fighterId, fighterId], (err, losses) => {
          if (err) return res.status(500).send('Lose query error');
          res.render('fighterProfile', { fighter, wins, losses });
        });
      });
    });
  });

  app.post('/fighters/add', upload.single('photo'), (req, res) => {
    const { name, camp, weight_class } = req.body;
    const photo = req.file ? '/uploads/' + req.file.filename : null;
    db.query(
      'INSERT INTO fighters (name, camp, weight_class, photo) VALUES (?, ?, ?, ?)',
      [name, camp, weight_class, photo],
      err => {
        if (err) return res.status(500).send('Insert error');
        res.redirect('/fighters');
      }
    );
  });

  app.post('/fighters/edit/:id', upload.single('photo'), (req, res) => {
    const { name, camp, weight_class } = req.body;
    const fighterId = req.params.id;
  
    // ดึงข้อมูลนักมวยเดิม เพื่อเช็ครูปเก่า
    db.query('SELECT photo FROM fighters WHERE id = ?', [fighterId], (err, results) => {
      if (err || results.length === 0) return res.status(404).send('Not found');
      
      let oldPhoto = results[0].photo;
      let newPhoto = oldPhoto;
  
      if (req.file) {
        newPhoto = '/uploads/' + req.file.filename;
        // ลบไฟล์รูปเก่า ถ้ามี
        if (oldPhoto) {
          const oldPath = __dirname + '/public' + oldPhoto;
          fs.unlink(oldPath, err => {
            if (err) console.error('ลบรูปเก่าไม่สำเร็จ:', err);
          });
        }
      }
  
      db.query(
        'UPDATE fighters SET name = ?, camp = ?, weight_class = ?, photo = ? WHERE id = ?',
        [name, camp, weight_class, newPhoto, fighterId],
        err => {
          if (err) return res.status(500).send('Update error');
          res.redirect('/fighters');
        }
      );
    });
  });

//--------------------------------------คือสร้าง match -------------------------------------------
app.get('/match/create', (req, res) => {
    db.query('SELECT * FROM fighters', (err, fighters) => {
      if (err) return res.status(500).send('DB error');
      res.render('createMatch', { fighters });
    });
  });
  app.post('/match/connect', (req, res) => {
    const { com4, com5 } = req.body;
  
    if (portCOM4) portCOM4.close();
    portCOM4 = new SerialPort({ path: com4, baudRate: 9600 }, (err) => {
      if (err) {
        isCOM4Connected = false;
        return res.status(500).json({ success: false, message: 'COM4 connect failed' });
      }
      isCOM4Connected = true;
      setupParser(portCOM4, 'COM4');
    });
  
    if (portCOM5) portCOM5.close();
    portCOM5 = new SerialPort({ path: com5, baudRate: 9600 }, (err) => {
      if (err) {
        isCOM5Connected = false;
        return res.status(500).json({ success: false, message: 'COM5 connect failed' });
      }
      isCOM5Connected = true;
      setupParser(portCOM5, 'COM5');
    });
  
    res.json({ success: true, message: 'Connecting to COM ports...' });
  });
  app.post('/match/create', (req, res) => {
    const { fighter1_id, fighter2_id } = req.body;
    if (!isCOM4Connected || !isCOM5Connected) {
      return res.status(400).send('Bluetooth devices not connected');
    }
    db.query(
      'INSERT INTO fights (fighter1_id, fighter2_id, fight_date) VALUES (?, ?, NOW())',
      [fighter1_id, fighter2_id],
      (err) => {
        if (err) return res.status(500).send('Create match failed');
        res.redirect('/match');
      }
    );
  });
  app.get('/match', (req, res) => {
    const sql = `
      SELECT f.id, f.fight_date, a.name AS fighter1, b.name AS fighter2
      FROM fights f
      JOIN fighters a ON f.fighter1_id = a.id
      JOIN fighters b ON f.fighter2_id = b.id
      ORDER BY f.fight_date DESC`;
    db.query(sql, (err, fights) => {
      if (err) return res.status(500).send('DB error');
      res.render('matchSchedule', { fights });
    });
  });

//-------------------------------------ตัวtest
  app.get('/test', (req, res) => {
      res.render('test', { isCOM6Connected });
    });
  
  // API เชื่อมต่อ COM6
  app.post('/test/connect', (req, res) => {
    const com6 = req.body.com6;
  
    if (portCOM6) portCOM6.close();
  
    portCOM6 = new SerialPort({ path: com6, baudRate: 9600 }, (err) => {
      if (err) {
        console.error('❌ เชื่อมต่อ COM6 ไม่สำเร็จ:', err.message);
        return res.json({ success: false });
      }
  
      // ✅ เชื่อมต่อสำเร็จ ส่งกลับ success
      console.log('✅ เชื่อมต่อ COM6 สำเร็จ');
  
      const parser = portCOM6.pipe(new ReadlineParser({ delimiter: '\r\n' }));
      parser.on('data', (data) => {
        console.log('📦 COM6:', data);
        io.emit('com6Data', data);
      });
  
      return res.json({ success: true }); // <-- สำคัญมาก!
    });
  });
  
  
  function setupParser(port) {
    const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    parser.on('data', (data) => {
      console.log('COM6 data:', data);
      io.emit('com6Data', data);  // ส่งข้อมูล realtime ผ่าน socket.io
    });
  }
    

//app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
server.listen(3000, () => console.log('Server running on http://localhost:3000'));

io.on('connection', (socket) => {
  console.log('Client connected');
  socket.emit('connectionStatus', { com4: isCOM4Connected, com5: isCOM5Connected });
});
