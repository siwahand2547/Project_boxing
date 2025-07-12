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
  // app.post('/match/connect', (req, res) => {
  //   const { com4, com5 } = req.body;
  
  //   if (portCOM4) portCOM4.close();
  //   portCOM4 = new SerialPort({ path: com4, baudRate: 9600 }, (err) => {
  //     if (err) {
  //       isCOM4Connected = false;
  //       return res.status(500).json({ success: false, message: 'COM4 connect failed' });
  //     }
  //     isCOM4Connected = true;
  //     setupParser(portCOM4, 'COM4');
  //   });
  
  //   if (portCOM5) portCOM5.close();
  //   portCOM5 = new SerialPort({ path: com5, baudRate: 9600 }, (err) => {
  //     if (err) {
  //       isCOM5Connected = false;
  //       return res.status(500).json({ success: false, message: 'COM5 connect failed' });
  //     }
  //     isCOM5Connected = true;
  //     setupParser(portCOM5, 'COM5');
  //   });
  
  //   res.json({ success: true, message: 'Connecting to COM ports...' });
  // });
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
// ======== เชื่อมต่อ COM6 ทันทีเมื่อรัน server =========
// const COM6_PORT = 'COM6'; // <-- ใส่พอร์ตของคุณตรงนี้ เช่น COM6, COM7
// let bufferValues = [];
// let waitingBelowThreshold = false;
// let lastReceiveTime = Date.now();

// function setupCOM6() {
//   portCOM6 = new SerialPort({ path: COM6_PORT, baudRate: 9600 }, (err) => {
//     if (err) {
//       console.error('❌ ไม่สามารถเชื่อมต่อ COM6 อัตโนมัติ:', err.message);
//       return;
//     }

//     isCOM6Connected = true;
//     console.log('✅ เชื่อมต่อ COM6 อัตโนมัติสำเร็จ');
//     io.emit('com6Status', true);

    
//     const parser = portCOM6.pipe(new ReadlineParser({ delimiter: '\r\n' }));


//     parser.on('data', (rawData) => {
//       const data = parseInt(rawData);

//       console.log(data);

//       if (isNaN(data)) return;


//       lastReceiveTime = Date.now();

//       if (data >= 1000) {
//         bufferValues.push(data);
//         waitingBelowThreshold = true;
//       } else if (waitingBelowThreshold && bufferValues.length > 0) {
//         const avg = Math.round(bufferValues.reduce((a, b) => a + b, 0) / bufferValues.length);
//         console.log('✅ ค่าเฉลี่ยที่เก็บได้:', avg);
//         io.emit('com6Data', avg);
//         bufferValues = [];
//         waitingBelowThreshold = false;
//       }
//     });

//     setInterval(() => {
//       const now = Date.now();
//       if (bufferValues.length > 0 && now - lastReceiveTime > 2000) {
//         const avg = Math.round(bufferValues.reduce((a, b) => a + b, 0) / bufferValues.length);
//         console.log('⏱️ Timeout - ค่าเฉลี่ยจาก COM6:', avg);
//         io.emit('com6Data', avg);
//         bufferValues = [];
//         waitingBelowThreshold = false;
//       }
//     }, 500);
//   });
// }

app.get('/test-com4', (req, res) => {
  res.render('testCOM4', { isCOM4Connected });
});

//---------------------------------------------------------สร้างตารางแข่งใหม่------------------------------------------------------------
app.get('/fights/data/:id', (req, res) => {
  const fightId = req.params.id;
  const sql = `
    SELECT f.id, f.fighter1_id, f.fighter2_id,
           a.name AS fighter1_name, a.camp AS fighter1_camp, a.weight_class AS fighter1_weight, a.photo AS fighter1_photo,
           b.name AS fighter2_name, b.camp AS fighter2_camp, b.weight_class AS fighter2_weight, b.photo AS fighter2_photo
    FROM fights f
    JOIN fighters a ON f.fighter1_id = a.id
    JOIN fighters b ON f.fighter2_id = b.id
    WHERE f.id = ?
  `;

  db.query(sql, [fightId], (err, results) => {
    if (err || results.length === 0) return res.status(404).send('ไม่พบข้อมูล');
    const row = results[0];
    const fighter1 = {
      name: row.fighter1_name,
      camp: row.fighter1_camp,
      weight_class: row.fighter1_weight,
      photo: row.fighter1_photo
    };
    const fighter2 = {
      name: row.fighter2_name,
      camp: row.fighter2_camp,
      weight_class: row.fighter2_weight,
      photo: row.fighter2_photo
    };
    res.render('datafight', { fighter1, fighter2 });
  });
});





//---------------------------------------------------------สร้างตารางแข่งใหม่------------------------------------------------------------
// setupCOM6();
// ======== เชื่อมต่อ COM4/COM5/COM6 อัตโนมัติ =========
const COM4_PORT = 'COM4';
const COM5_PORT = 'COM5';
const COM6_PORT = 'COM6';

let bufferValues = [];
let bufferCOM4 = [], waitingCOM4 = false, lastTimeCOM4 = Date.now();
let bufferCOM5 = [], waitingCOM5 = false, lastTimeCOM5 = Date.now();
let waitingBelowThreshold = false;
let lastReceiveTime = Date.now();

function setupCOM6() {
  portCOM6 = new SerialPort({ path: COM6_PORT, baudRate: 9600 }, (err) => {
    if (err) {
      console.error('❌ ไม่สามารถเชื่อมต่อ COM6:', err.message);
      return;
    }
    isCOM6Connected = true;
    console.log('✅ เชื่อมต่อ COM6 สำเร็จ');
    io.emit('com6Status', true);

    const parser = portCOM6.pipe(new ReadlineParser({ delimiter: '\r\n' }));

    parser.on('data', (rawData) => {
      const data = parseInt(rawData);
      if (isNaN(data)) return;

      lastReceiveTime = Date.now();

      if (data >= 1000) {
        bufferValues.push(data);
        waitingBelowThreshold = true;
      } else if (waitingBelowThreshold && bufferValues.length > 0) {
        const avg = Math.round(bufferValues.reduce((a, b) => a + b, 0) / bufferValues.length);
        console.log('✅ COM6 ค่าเฉลี่ย:', avg);
        io.emit('com6Data', avg);
        bufferValues = [];
        waitingBelowThreshold = false;
      }
    });

    setInterval(() => {
      if (bufferValues.length > 0 && Date.now() - lastReceiveTime > 2000) {
        const avg = Math.round(bufferValues.reduce((a, b) => a + b, 0) / bufferValues.length);
        console.log('⏱️ COM6 Timeout ส่งค่าเฉลี่ย:', avg);
        io.emit('com6Data', avg);
        bufferValues = [];
        waitingBelowThreshold = false;
      }
    }, 500);
  });
}

function setupCOM4() {
  portCOM4 = new SerialPort({ path: COM4_PORT, baudRate: 9600 }, (err) => {
    if (err) {
      console.error('❌ COM4 connect failed:', err.message);
      return;
    }

    isCOM4Connected = true;
    console.log('✅ COM4 connected automatically');
    io.emit('com4Status', true);

    const parser = portCOM4.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    parser.on('data', (rawData) => {
      const data = parseInt(rawData);
      console.log('📥 ข้อมูลดิบจาก COM4:', rawData);
      if (isNaN(data)) return;

      lastTimeCOM4 = Date.now();

      if (data >= 1000) {
        bufferCOM4.push(data);
        waitingCOM4 = true;
      } else if (waitingCOM4 && bufferCOM4.length > 0) {
        const avg = Math.round(bufferCOM4.reduce((a, b) => a + b, 0) / bufferCOM4.length);
        console.log('✅ COM4 avg:', avg);
        io.emit('com4Data', avg);
        bufferCOM4 = [];
        waitingCOM4 = false;
      }
    });

    setInterval(() => {
      const now = Date.now();
      if (bufferCOM4.length > 0 && now - lastTimeCOM4 > 2000) {
        const avg = Math.round(bufferCOM4.reduce((a, b) => a + b, 0) / bufferCOM4.length);
        console.log('⏱️ Timeout COM4 avg:', avg);
        io.emit('com4Data', avg);
        bufferCOM4 = [];
        waitingCOM4 = false;
      }
    }, 500);
  });
}


function setupCOM5() {
  portCOM5 = new SerialPort({ path: COM5_PORT, baudRate: 9600 }, (err) => {
    if (err) {
      console.error('❌ COM5 connect failed:', err.message);
      return;
    }

    isCOM5Connected = true;
    console.log('✅ COM5 connected automatically');
    io.emit('com5Status', true);

    const parser = portCOM5.pipe(new ReadlineParser({ delimiter: '\r\n' }));
    parser.on('data', (rawData) => {
      const data = parseInt(rawData);
      console.log('📥 ข้อมูลดิบจาก COM5:', rawData); 
      if (isNaN(data)) return;

      lastTimeCOM5 = Date.now();

      if (data >= 1000) {
        bufferCOM5.push(data);
        waitingCOM5 = true;
      } else if (waitingCOM5 && bufferCOM5.length > 0) {
        const avg = Math.round(bufferCOM5.reduce((a, b) => a + b, 0) / bufferCOM5.length);
        console.log('✅ COM5 avg:', avg);
        io.emit('com5Data', avg);
        bufferCOM5 = [];
        waitingCOM5 = false;
      }
    });

    setInterval(() => {
      const now = Date.now();
      if (bufferCOM5.length > 0 && now - lastTimeCOM5 > 2000) {
        const avg = Math.round(bufferCOM5.reduce((a, b) => a + b, 0) / bufferCOM5.length);
        console.log('⏱️ Timeout COM5 avg:', avg);
        io.emit('com5Data', avg);
        bufferCOM5 = [];
        waitingCOM5 = false;
      }
    }, 500);
  });
}
// รับวิดีโอที่ client อัปโหลด
app.post('/upload-video', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No video uploaded' });
  }

  const videoPath = '/uploads/' + req.file.filename;
  res.json({ success: true, url: videoPath });
});


// เรียกตอนเริ่มเซิร์ฟเวอร์
setupCOM4();
setupCOM5();
setupCOM6();

//-----------------------------------repaly--------------------------------------------------------
app.get('/replay', (req, res) => {
  res.render('replay');
});
//-----------------------------------repaly--------------------------------------------------------

//app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
server.listen(3000, () => console.log('Server running on http://localhost:3000'));

io.on('connection', (socket) => {
  console.log('Client connected');
  socket.emit('connectionStatus', { com4: isCOM4Connected, com5: isCOM5Connected });
});
