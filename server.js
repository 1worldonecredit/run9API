const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
// --- วาง CORS ตรงนี้เลยครับ ---
app.use(cors({
    origin: ['https://run9.app', 'https://soidao.run9.app','http://localhost:5173'], // เพิ่ม localhost สำหรับใช้ทดสอบตอนเขียนโค้ด
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

// [อัปเดตสำคัญ!] ขยายขนาดประตูรับข้อมูลของ Node.js ให้รองรับรูปภาพ (Base64) ที่มีขนาดใหญ่ได้สูงสุด 10MB
// ถ้าไม่ใส่ 2 บรรทัดนี้ อัปโหลดรูปไปแล้วระบบจะฟ้อง Error ว่า Payload Too Large ครับ
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const cron = require('node-cron');



const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: { encrypt: false, trustServerCertificate: true }
};

// ฟังก์ชันสุ่มตัวเลขแบบเติม 0 ด้านหน้า (เช่น สุ่มได้ 5 ให้กลายเป็น 05 หรือ 005)
const generateWinningNumber = (digits) => {
    const max = Math.pow(10, digits);
    const randomNum = Math.floor(Math.random() * max);
    return randomNum.toString().padStart(digits, '0');
};
// ==============================================================
// 🌟 ฟังก์ชันแกนกลาง: คำนวณเงินทบยอด และ สุ่มเลขรางวัล (2D, 3D, 4D, 6D)
// ==============================================================
async function processNewDayGame() {
    console.log('⏳ รันระบบคำนวณเงินสะสมและสุ่มเลขรางวัลประจำวัน...');
    try {
        let pool = await sql.connect(config);

        // 1. ดึงข้อมูลของวันนี้ (ก่อนที่จะเปลี่ยนวัน) เพื่อเช็คว่ามีคนถูกไหม
        const todayRes = await pool.request().query(`SELECT * FROM DailyWinningNumbers WHERE GameDate = CAST(GETDATE() AS DATE)`);

        if (todayRes.recordset.length > 0) {
            const today = todayRes.recordset[0];
            // 2. ทบยอดเงินรางวัล (ถ้าไม่มีคนถูก เอาเงินเดิมบวกเพิ่ม)
            await pool.request().query(`
                UPDATE GamePrizeSettings 
                SET 
                    CurrentJackpot2D = ${ (today.IsWon2D) ? "Prize2D" : "ISNULL(CurrentJackpot2D, Prize2D) + Prize2D" },
                    CurrentJackpot3D = ${ (today.IsWon3D) ? "Prize3D" : "ISNULL(CurrentJackpot3D, Prize3D) + Prize3D" },
                    CurrentJackpot4D = ${ (today.IsWon4D) ? "Prize4D" : "ISNULL(CurrentJackpot4D, Prize4D) + Prize4D" },
                    CurrentJackpot6D = ${ (today.IsWon6D) ? "Prize6D_Base" : "ISNULL(CurrentJackpot6D, Prize6D_Base) + Prize6D_Base" }
                WHERE Id = 1
            `);
        }

        // 3. ลบเลขเก่าของวันนี้ออก
        await pool.request().query(`DELETE FROM DailyWinningNumbers WHERE GameDate = CAST(GETDATE() AS DATE)`);

        // 4. สุ่มเลขใหม่ โดยใช้ฟังก์ชัน generateWinningNumber ของคุณ (และเพิ่ม 6D)
        const win2D = generateWinningNumber(2);
        const win3D = generateWinningNumber(3);
        const win4D = generateWinningNumber(4);
        const win6D = generateWinningNumber(6);

        await pool.request()
            .input('w2', sql.VarChar, win2D)
            .input('w3', sql.VarChar, win3D)
            .input('w4', sql.VarChar, win4D)
            .input('w6', sql.VarChar, win6D) // 🌟 เพิ่มพารามิเตอร์ 6D
            .query(`
                INSERT INTO DailyWinningNumbers (WinNumber2D, WinNumber3D, WinNumber4D, WinNumber6D, GameDate)
                VALUES (@w2, @w3, @w4, @w6, CAST(GETDATE() AS DATE))
            `);
            
        console.log(`🎉 สุ่มเลขและทบยอดสำเร็จ! 2D: ${win2D}, 3D: ${win3D}, 4D: ${win4D}, 6D: ${win6D}`);
        return true;
    } catch (err) {
        console.error("❌ เกิดข้อผิดพลาดในระบบอัตโนมัติ:", err.message);
        return false;
    }
}

// ==============================================================
// 🌟 API: บันทึก/อัปเดต ชื่อ-นามสกุล (ลงตาราง UserNames)
// ==============================================================
app.post('/api/user/update-name', async (req, res) => {
    const { username, firstName, lastName } = req.body;

    try {
        let pool = await sql.connect(config);
        
        // 1. เช็กว่าเคยมีชื่อในระบบหรือยัง
        const checkName = await pool.request()
            .input('user', sql.VarChar, username)
            .query(`SELECT Id FROM UserNames WHERE Username = @user`);

        if (checkName.recordset.length > 0) {
            // 🔄 มีแล้ว -> อัปเดต และบังคับให้ Status เป็น Active
            await pool.request()
                .input('user', sql.VarChar, username)
                .input('fname', sql.NVarChar, firstName)
                .input('lname', sql.NVarChar, lastName)
                .query(`UPDATE UserNames SET FirstName = @fname, LastName = @lname, Status = 'Active' WHERE Username = @user`);
        } else {
            // 🆕 ยังไม่มี -> เพิ่มใหม่ พร้อมกำหนด Status เป็น Active
            await pool.request()
                .input('user', sql.VarChar, username)
                .input('fname', sql.NVarChar, firstName)
                .input('lname', sql.NVarChar, lastName)
                .query(`INSERT INTO UserNames (Username, FirstName, LastName, Status, CreatedAt) VALUES (@user, @fname, @lname, 'Active', GETDATE())`);
        }

        res.json({ success: true, message: "บันทึกชื่อ-นามสกุลสำเร็จ!" });
    } catch (err) {
        console.error("🔥 Update Name Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
// ==============================================================
// 🌟 1. CRON JOB: สุ่มเลขรางวัลและทบยอด ทุกเที่ยงคืน (00:00 น.)
// ==============================================================
cron.schedule('0 0 * * *', async () => {
    await processNewDayGame();
});


app.get('/get-user-info/:username', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const username = req.params.username;

        // 1. ดึงวันเดือนปีเกิด (จากตาราง UsersRegister ที่เราเพิ่งเพิ่มคอลัมน์ไป)
        // ใช้ CONVERT 120 เพื่อให้วันที่ออกมาเป็นรูปแบบ YYYY-MM-DD เสมอ (React จะได้คำนวณอายุได้เป๊ะๆ)
        let registerResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT CONVERT(VARCHAR(10), DateOfBirth, 120) AS dobFormatted FROM UsersRegister WHERE Username = @user");
        
        // 2. ดึงชื่อ-สกุล (จากตาราง UserNames)
        let nameResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT TOP 1 FirstName, LastName FROM UserNames WHERE Username = @user AND Status = 'Active' ORDER BY CreatedAt DESC");

        // 3. ดึงเบอร์โทรศัพท์ (จากตาราง UserPhones)
        let phoneResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT TOP 1 PhoneNumber FROM UserPhones WHERE Username = @user AND Status = 'Active' ORDER BY CreatedAt DESC");

        // 4. ดึงอีเมล (จากตาราง UserEmails)
        let emailResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT TOP 1 Email FROM UserEmails WHERE Username = @user AND Status = 'Active' ORDER BY CreatedAt DESC");

       // 5. ดึงที่อยู่แบบเต็มรูปแบบ (JOIN กับตารางพื้นที่)
        let addressResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query(`
                SELECT TOP 1 
                    a.AddressDetail + N' ต.' + s.SubDistrictName + N' อ.' + d.DistrictName + N' จ.' + p.ProvinceName + ' ' + CAST(d.Zipcode AS VARCHAR) AS FullAddress
                FROM UserAddresses a
                LEFT JOIN SubDistricts s ON a.SubDistrictId = s.Id
                LEFT JOIN Districts d ON s.DistrictId = d.Id
                LEFT JOIN Provinces p ON d.ProvinceId = p.Id
                WHERE a.Username = @user AND a.Status = 'Active'
                ORDER BY a.CreatedAt DESC
            `);

        // 6. ดึงบัญชีธนาคาร (จากตาราง UserBankAccounts)
        let bankResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT TOP 1 BankName, AccountNumber FROM UserBankAccounts WHERE Username = @user AND Status IN ('Pending', 'Approved') ORDER BY CreatedAt DESC");

        // 7. สร้างก้อนข้อมูลเตรียมส่งกลับไปให้ React (เอาข้อมูลมารวมกัน)
        let userData = {
            fullName: nameResult.recordset.length > 0 ? `${nameResult.recordset[0].FirstName} ${nameResult.recordset[0].LastName}` : '',
            phone: phoneResult.recordset.length > 0 ? phoneResult.recordset[0].PhoneNumber : '',
            email: emailResult.recordset.length > 0 ? emailResult.recordset[0].Email : '',
            address: addressResult.recordset.length > 0 ? addressResult.recordset[0].FullAddress : '',
            
            // 👇 ตรงนี้แหละครับที่เราเพิ่มเข้ามา เพื่อดึงวันเกิดไปแสดง 👇
            dob: registerResult.recordset.length > 0 && registerResult.recordset[0].dobFormatted ? registerResult.recordset[0].dobFormatted : '',
            
            bank: bankResult.recordset.length > 0 ? `${bankResult.recordset[0].BankName} ${bankResult.recordset[0].AccountNumber}` : '',
            store: '', // รอเชื่อมระบบร้านค้า
            rider: ''  // รอเชื่อมระบบไรเดอร์
        };

        res.json(userData);
    } catch (err) {
        console.error("Error fetching user info:", err);
        res.status(500).json({ error: err.message });
    }
});



// ==============================================================
// 🌟 2. API สำหรับแอดมิน (ปุ่ม "จำลองข้ามวัน" ในหน้า React)
// ==============================================================
app.post('/api/game/trigger-new-day', async (req, res) => {
    const success = await processNewDayGame();
    if (success) {
        res.json({ success: true, message: "จำลองการขึ้นวันใหม่และทบยอดสะสมสำเร็จ!" });
    } else {
        res.status(500).json({ error: "ไม่สามารถอัปเดตวันใหม่ได้" });
    }
});

// ==============================================================
// 🌟 3. API: ดึงสถานะเกม (อัปเดตให้ดึงยอดสะสมทุกรางวัล)
// ==============================================================
app.get('/api/game/status', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const todayGame = await pool.request().query(`SELECT * FROM DailyWinningNumbers WHERE GameDate = CAST(GETDATE() AS DATE)`);
        // เปลี่ยนมาดึง * เพื่อเอาคอลัมน์ CurrentJackpot ทั้งหมดไปโชว์
        const prizes = await pool.request().query(`SELECT * FROM GamePrizeSettings WHERE Id = 1`);

        if (todayGame.recordset.length > 0) {
            res.json({ status: todayGame.recordset[0], prizes: prizes.recordset[0] });
        } else {
            res.status(404).json({ error: "ยังไม่มีการสุ่มรางวัลสำหรับวันนี้" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});



// ==============================================================
// 🌟 API: ดึงประวัติการเล่นเกม (Play History)
// ==============================================================
app.get('/api/game/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        let pool = await sql.connect(config);
        
        // ดึงประวัติการเล่น 50 รายการล่าสุด
        const historyRes = await pool.request()
            .input('uid', sql.Int, userId)
            .query(`
                SELECT TOP 50 * FROM SoiDaoPlayLogs 
                WHERE UserId = @uid 
                ORDER BY CreatedAt DESC
            `);
            
        res.json({ success: true, history: historyRes.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: ผูกบัญชีธนาคาร (ตรวจสอบชื่อให้ตรงกับ KYC)
// ==============================================================
app.post('/api/wallet/bind-bank', async (req, res) => {
    const { username, bankName, accountNumber, accountName } = req.body;

    if (!username || !bankName || !accountNumber || !accountName) {
        return res.status(400).json({ error: "กรุณากรอกข้อมูลบัญชีธนาคารให้ครบถ้วน" });
    }

    try {
        let pool = await sql.connect(config);

        // 1. ดึงข้อมูลชื่อ-นามสกุลจริงที่ผ่าน KYC แล้ว (จากตาราง UserNames หรือตารางที่คุณใช้เก็บข้อมูลส่วนตัว)
        let kycCheck = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT FirstName, LastName FROM UserNames WHERE Username = @user");

        if (kycCheck.recordset.length === 0) {
            return res.status(400).json({ error: "บัญชีนี้ยังไม่ได้ยืนยันตัวตน (KYC) กรุณายืนยันตัวตนก่อนผูกบัญชีธนาคาร" });
        }

        const kycFullName = `${kycCheck.recordset[0].FirstName} ${kycCheck.recordset[0].LastName}`.trim().toLowerCase();
        const inputAccountName = accountName.trim().toLowerCase();

        // 2. ตรวจสอบว่าชื่อบัญชีธนาคาร ตรงกับชื่อที่ KYC ไว้หรือไม่
        if (inputAccountName !== kycFullName) {
            return res.status(400).json({ 
                error: `ชื่อบัญชีธนาคารไม่ตรงกับข้อมูลในระบบ (ชื่อในระบบ: ${kycCheck.recordset[0].FirstName} ${kycCheck.recordset[0].LastName})` 
            });
        }

        // 3. ตรวจสอบว่าเคยผูกบัญชีนี้ไปแล้วหรือยัง
        let bankCheck = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT Id FROM UserBankAccounts WHERE Username = @user");

        if (bankCheck.recordset.length > 0) {
            // อัปเดตบัญชีเดิม
            await pool.request()
                .input('user', sql.VarChar, username)
                .input('bName', sql.NVarChar, bankName)
                .input('bAcc', sql.VarChar, accountNumber)
                .input('aName', sql.NVarChar, accountName)
                .query(`
                    UPDATE UserBankAccounts 
                    SET BankName = @bName, AccountNumber = @bAcc, AccountName = @aName, IsVerified = 1, CreatedAt = DATEADD(hour, 7, GETUTCDATE())
                    WHERE Username = @user
                `);
        } else {
            // บันทึกบัญชีใหม่
            await pool.request()
                .input('user', sql.VarChar, username)
                .input('bName', sql.NVarChar, bankName)
                .input('bAcc', sql.VarChar, accountNumber)
                .input('aName', sql.NVarChar, accountName)
                .query(`
                    INSERT INTO UserBankAccounts (Username, BankName, AccountNumber, AccountName, IsVerified)
                    VALUES (@user, @bName, @bAcc, @aName, 1)
                `);
        }

        res.json({ success: true, message: "ผูกบัญชีธนาคารสำเร็จและยืนยันชื่อตรงตามระบบเรียบร้อย!" });

    } catch (err) {
        res.status(500).json({ error: "เซิร์ฟเวอร์ขัดข้อง: " + err.message });
    }
});
// ==============================================================
// 🌟 API ดึง dropdown list หน้า Profile เพิ่มบัญชีธนาคาร
// ==============================================================
// 🌟 API: ดึงรายชื่อธนาคารทั้งหมด (แบบไม่มีเงื่อนไข เพื่อทดสอบ)
// ==============================================================
app.get('/api/system-banks', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        
        // 🌟 ดึงข้อมูลตรงๆ จากตาราง SystemBanks
        const result = await pool.request().query(`
            SELECT Id, BankName, Country 
            FROM SystemBanks
            ORDER BY BankName ASC
        `);
        
        res.json({ success: true, banks: result.recordset });
    } catch (err) {
        console.error("🔥 Fetch Banks Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});




// ==============================================================
// 🌟 API (Admin): พนักงานเพิ่มบัญชีธนาคารของระบบ (อัปเดตรองรับ Country)
// ==============================================================
app.post('/api/admin/system-banks', async (req, res) => {
    // 🌟 รับค่า country เพิ่มเข้ามา
    const { country, bankName, accountNumber, accountName } = req.body;

    if (!country || !bankName || !accountNumber || !accountName) {
        return res.status(400).json({ error: "กรุณากรอกข้อมูลบัญชีรับเงินให้ครบถ้วน" });
    }

    try {
        let pool = await sql.connect(config);
        await pool.request()
            .input('country', sql.NVarChar, country) // 🌟 แมปตัวแปร
            .input('bName', sql.NVarChar, bankName)
            .input('bAcc', sql.VarChar, accountNumber)
            .input('aName', sql.NVarChar, accountName)
            .query(`
                INSERT INTO SystemBankAccounts (Country, BankName, AccountNumber, AccountName, IsActive) 
                VALUES (@country, @bName, @bAcc, @aName, 1)
            `);
            
        res.json({ success: true, message: `เพิ่มบัญชีรับเงินของระบบสำหรับ ${country} เรียบร้อยแล้ว!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: แจ้งฝาก/ถอนเงิน (สถานะ PENDING รอแอดมินตรวจสอบ)
// ==============================================================
app.post('/api/wallet/transaction', async (req, res) => {
    const { username, amount, type, systemBankId, slipImage, transferDate, transferTime } = req.body; 

    if (!username || !amount || amount <= 0) return res.status(400).json({ error: "ข้อมูลไม่ถูกต้อง" });

    try {
        let pool = await sql.connect(config);
        
        const userResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT Id FROM UsersRegister WHERE Username = @user");
            
        if (userResult.recordset.length === 0) return res.status(404).json({ error: "ไม่พบข้อมูลผู้ใช้งาน" });
        const userId = userResult.recordset[0].Id; 

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 🌟 1. บันทึกประวัติลงตาราง Transactions และตั้งสถานะเป็น 'PENDING' (รอตรวจสอบ)
            // ❌ ไม่มีการอัปเดตยอดเงินในตาราง Wallets ตรงนี้แล้ว!
            await transaction.request()
                .input('uid', sql.Int, userId)
                .input('type', sql.VarChar, type)
                .input('amt', sql.Decimal(18,2), amount)
                .input('bankId', sql.Int, systemBankId || null)
                .input('slip', sql.NVarChar(sql.MAX), slipImage || null)
                .input('tDate', sql.VarChar, transferDate || null)
                .input('tTime', sql.VarChar, transferTime || null)
                .query(`
                    INSERT INTO Transactions (UserId, TransactionType, Amount, SystemBankId, SlipImage, TransferDate, TransferTime, Status) 
                    VALUES (@uid, @type, @amt, @bankId, @slip, @tDate, @tTime, 'PENDING')
                `);

            // 🌟 2. ส่ง Notification แจ้งผู้เล่นว่า "กำลังรอตรวจสอบ"
            const notifTitle = type === 'DEPOSIT' ? 'ส่งคำขอเติมเงินสำเร็จ' : 'ส่งคำขอถอนเงินสำเร็จ';
            const notifMessage = type === 'DEPOSIT' 
                ? `ระบบได้รับหลักฐานการโอนเงิน ${amount} บาท ของคุณแล้ว กรุณารอแอดมินตรวจสอบและกระทบยอดสักครู่`
                : `ระบบได้รับคำขอถอนเงิน ${amount} บาท ของคุณแล้ว กรุณารอแอดมินดำเนินการสักครู่`;
            
            await transaction.request()
                .input('user', sql.VarChar, username)
                .input('title', sql.NVarChar, notifTitle)
                .input('msg', sql.NVarChar, notifMessage)
                .query(`INSERT INTO Notifications (Username, Title, Message) VALUES (@user, @title, @msg)`);

            await transaction.commit();
            res.json({ success: true, message: "แจ้งทำรายการสำเร็จ กรุณารอการตรวจสอบ" });
        } catch (err) {
            await transaction.rollback(); 
            throw err;
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ==============================================================
// 🌟 API (Admin): 1. ดึงรายการฝาก/ถอน (อัปเดตให้ดึงข้อมูลแม่นยำขึ้น)
// ==============================================================
app.get('/api/admin/transactions', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        
        // ใช้ LEFT JOIN เพื่อให้ดึงรายการมาโชว์เสมอ แม้จะหาชื่อ User ไม่เจอก็ตาม
        const result = await pool.request().query("SELECT * FROM Transactions ORDER BY CreatedAt DESC");
        
        console.log("จำนวนรายการที่ดึงได้จาก DB:", result.recordset.length); // 🌟 ดูใน Terminal ว่าได้กี่แถว
        res.json({ success: true, transactions: result.recordset });
    } catch (err) { 
        console.error("Error fetching transactions:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// ==============================================================
// 🌟 API (Admin): 2. แอดมินกดยืนยัน (Approve) และคิดเงินปันผลอัตโนมัติ!
// ==============================================================
app.post('/api/admin/transactions/approve', async (req, res) => {
    // 🌟 1. รับมาแค่ transactionId ตัวเดียวพอ ปลอดภัยกว่า!
    const { transactionId } = req.body;

    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 🌟 2. ดึงข้อมูลบิล (Transactions) เพื่อหา UserId และ Amount ที่แท้จริง ป้องกันข้อมูลผิดพลาด
            const txCheck = await transaction.request()
                .input('txId', sql.Int, transactionId)
                .query(`
                    SELECT t.UserId, t.Amount, u.Username 
                    FROM Transactions t
                    LEFT JOIN UsersRegister u ON t.UserId = u.Id
                    WHERE t.Id = @txId AND t.Status = 'PENDING'
                `);

            if (txCheck.recordset.length === 0) {
                throw new Error("ไม่พบบิลนี้ หรือบิลถูกอนุมัติไปแล้ว");
            }

            // ได้ข้อมูลที่ชัวร์ 100% มาใช้งาน
            const actualUserId = txCheck.recordset[0].UserId;
            const actualAmount = txCheck.recordset[0].Amount;
            const actualUsername = txCheck.recordset[0].Username || 'ไม่ระบุชื่อ';

            // 🌟 3. กระบวนการคำนวณเงินปันผล + อัปเดตเงิน (เพิ่มระบบเช็กสร้างกระเป๋าสำหรับ User ใหม่)
            const processDividendAndBalance = `
                DECLARE @CurrentBalance DECIMAL(18,4) = 0;
                DECLARE @LastUpdated DATETIME = NULL;
                DECLARE @Now DATETIME = GETDATE();
                DECLARE @Dividend DECIMAL(18,4) = 0;
                DECLARE @DaysPassed FLOAT = 0;
                DECLARE @Rate FLOAT = 0.10; 

                -- อ่านค่ายอดเงิน + เวลาอัปเดตล่าสุด
                SELECT @CurrentBalance = ISNULL(Balance, 0), @LastUpdated = LastUpdated 
                FROM Wallets WITH (UPDLOCK) 
                WHERE UserId = @uid;

                -- ก. คำนวณเงินปันผล
                IF @CurrentBalance > 0 AND @LastUpdated IS NOT NULL
                BEGIN
                    SET @DaysPassed = DATEDIFF(SECOND, @LastUpdated, @Now) / 86400.0;
                    SET @Dividend = @CurrentBalance * @Rate * (@DaysPassed / 365.0);
                END

                -- ข. จ่ายเงินปันผล
                IF @Dividend > 0.000001
                BEGIN
                    SET @CurrentBalance = @CurrentBalance + @Dividend;
                    INSERT INTO Transactions (UserId, TransactionType, Amount, Status, CreatedAt)
                    VALUES (@uid, 'DIVIDEND', @Dividend, 'COMPLETED', @Now);
                END

                -- ค. บวกยอดเงินฝากที่แอดมินอนุมัติ
                SET @CurrentBalance = @CurrentBalance + @amt;

                -- 🌟 ง. อัปเดตกระเป๋ากลับไป (ถ้ามีกระเป๋าให้อัปเดต ถ้าไม่มีให้สร้างใหม่)
                IF EXISTS (SELECT 1 FROM Wallets WHERE UserId = @uid)
                BEGIN
                    UPDATE Wallets 
                    SET Balance = @CurrentBalance, LastUpdated = @Now 
                    WHERE UserId = @uid;
                END
                ELSE
                BEGIN
                    INSERT INTO Wallets (UserId, Balance, Currency, LastUpdated)
                    VALUES (@uid, @CurrentBalance, 'THB', @Now);
                END
            `;

            await transaction.request()
                .input('uid', sql.Int, actualUserId)
                .input('amt', sql.Decimal(18,4), actualAmount)
                .query(processDividendAndBalance);

            // 4. อัปเดตสถานะบิลหลักที่แอดมินกดอนุมัติเป็น 'COMPLETED'
            await transaction.request()
                .input('txId', sql.Int, transactionId)
                .query(`UPDATE Transactions SET Status = 'COMPLETED' WHERE Id = @txId`);

            // 5. ส่ง Notification แจ้งผู้เล่นว่า "เงินเข้าแล้ว!"
            await transaction.request()
                .input('user', sql.VarChar, actualUsername)
                .input('title', sql.NVarChar, 'ยอดเงินเข้ากระเป๋าแล้ว')
                .input('msg', sql.NVarChar, `แอดมินตรวจสอบยอดเงินฝากสำเร็จ! ยอดเงินถูกเพิ่มเข้ากระเป๋าของคุณแล้ว`)
                .query(`INSERT INTO Notifications (Username, Title, Message) VALUES (@user, @title, @msg)`);

            await transaction.commit();
            res.json({ success: true, message: "กระทบยอดและเติมเงินสำเร็จ!" });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});



// ==============================================================
// 🌟 API (Admin): ดึงสถิติภาพรวมสำหรับหน้า Dashboard
// ==============================================================
app.get('/api/admin/dashboard-stats', async (req, res) => {
    try {
        let pool = await sql.connect(config);

        // 1. นับจำนวนพนักงานทั้งหมด (จากตาราง Employees ที่คุณมี)
        const empResult = await pool.request().query("SELECT COUNT(*) AS Total FROM Employees");
        const totalEmployees = empResult.recordset[0].Total;

        // 2. นับรายการที่รอตรวจสอบ (ตอนนี้เราดึงบิล PENDING จากตาราง Transactions มาแสดงก่อน)
        const pendingResult = await pool.request().query("SELECT COUNT(*) AS Total FROM Transactions WHERE Status = 'PENDING'");
        const pendingItems = pendingResult.recordset[0].Total;

        // 3. นับรายการที่ทำสำเร็จของวันนี้ (COMPLETED วันนี้)
        const todayResult = await pool.request().query(`
            SELECT COUNT(*) AS Total 
            FROM Transactions 
            WHERE Status = 'COMPLETED' 
            AND CAST(CreatedAt AS DATE) = CAST(GETUTCDATE() AS DATE)
        `);
        const completedToday = todayResult.recordset[0].Total;

        res.json({
            success: true,
            stats: {
                totalEmployees,
                pendingItems,
                completedToday
            }
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ==============================================================
// 🌟 API (User): ดึงการแจ้งเตือนของฉัน (เฉพาะที่ยังไม่ถูกซ่อน)
// ==============================================================
app.get('/api/notifications/:username', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('user', sql.VarChar, req.params.username)
            .query("SELECT * FROM Notifications WHERE Username = @user AND IsHidden = 0 ORDER BY CreatedAt DESC");
        res.json({ success: true, notifications: result.recordset });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ==============================================================
// 🌟 API (User): ซ่อนการแจ้งเตือน (Soft Delete = เปลี่ยน IsHidden เป็น 1)
// ==============================================================
app.put('/api/notifications/:id/hide', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, req.params.id)
            .query("UPDATE Notifications SET IsHidden = 1 WHERE Id = @id");
        res.json({ success: true, message: "ซ่อนการแจ้งเตือนสำเร็จ" });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});



// ==============================================================
// 🌟 4. API: เล่นเกมสอยดาว (จ่ายเงินตามยอดสะสมจริง)
// ==============================================================
// ... (ตรงนี้โค้ด /api/game/play เหมือนเดิมเกือบหมด ยกเว้นจุดจ่ายเงิน)
app.post('/api/game/play', async (req, res) => {
    const { userId, guessNumber, gameType } = req.body; 
    let pool = await sql.connect(config);
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();

        const todayReq = new sql.Request(transaction);
        const todayRes = await todayReq.query(`SELECT * FROM DailyWinningNumbers WITH (UPDLOCK) WHERE GameDate = CAST(GETDATE() AS DATE)`);
        if (todayRes.recordset.length === 0) throw new Error("ยังไม่มีการเปิดเกมวันนี้");
        
        const todayGame = todayRes.recordset[0];
        const isWonCol = `IsWon${gameType}`;
        const winNumCol = `WinNumber${gameType}`;
        const winnerIdCol = `WinnerId${gameType}`;

        if (todayGame[isWonCol] === true || todayGame[isWonCol] === 1) {
            throw new Error(`เสียใจด้วย! รางวัลแจ็คพ็อต ${gameType} มีผู้รับไปแล้ว`);
        }

        const ticketCost = gameType === '6D' ? 100 : 20; 
        const ticketReq = new sql.Request(transaction);
        ticketReq.input('uid', sql.Int, userId);
        const ticketRes = await ticketReq.query(`SELECT FreeTickets FROM UserGameTickets WHERE UserId = @uid`);
        
        let isFreePlay = false;
        if (ticketRes.recordset.length > 0 && ticketRes.recordset[0].FreeTickets > 0) {
            isFreePlay = true;
            await (new sql.Request(transaction)).input('uid', sql.Int, userId).query(`UPDATE UserGameTickets SET FreeTickets = FreeTickets - 1 WHERE UserId = @uid`);
        } else {
            const walletReq = new sql.Request(transaction);
            walletReq.input('uid', sql.Int, userId);
            const walletRes = await walletReq.query(`SELECT Balance FROM Wallets WHERE UserId = @uid`);
            if (walletRes.recordset.length === 0 || walletRes.recordset[0].Balance < ticketCost) throw new Error(`ยอดเงินไม่พอซื้อสิทธิ์ (${ticketCost} บาท)`);
            await (new sql.Request(transaction)).input('uid', sql.Int, userId).input('cost', sql.Decimal, ticketCost).query(`UPDATE Wallets SET Balance = Balance - @cost WHERE UserId = @uid`);
        }

        let isWinner = false; let message = "เฉียดไปนิดเดียว! ลองใหม่อีกครั้งนะ"; let payoutKip = 0; let matchedPairs = 0;
        const prizeRes = await (new sql.Request(transaction)).query(`SELECT * FROM GamePrizeSettings WHERE Id = 1`);
        const settings = prizeRes.recordset[0];

        if (gameType === '6D') {
            let winFront = todayGame.WinNumber6D.substring(0, 2); let winMid = todayGame.WinNumber6D.substring(2, 4); let winBack = todayGame.WinNumber6D.substring(4, 6);
            const guessFront = guessNumber.substring(0, 2); const guessMid = guessNumber.substring(2, 4); const guessBack = guessNumber.substring(4, 6);
            let newWinFront = winFront; let newWinMid = winMid; let newWinBack = winBack;

            if (guessFront === winFront) { matchedPairs++; newWinFront = Math.floor(Math.random() * 100).toString().padStart(2, '0'); }
            if (guessMid === winMid) { matchedPairs++; newWinMid = Math.floor(Math.random() * 100).toString().padStart(2, '0'); }
            if (guessBack === winBack) { matchedPairs++; newWinBack = Math.floor(Math.random() * 100).toString().padStart(2, '0'); }

            if (matchedPairs === 3) {
                isWinner = true; payoutKip = settings.CurrentJackpot6D; message = "🎉 โคตรเมกะแจ็คพ็อตแตก!! คุณถูกทั้ง 3 คู่!";
                await (new sql.Request(transaction)).input('uid', sql.Int, userId).query(`UPDATE DailyWinningNumbers SET IsWon6D = 1, WinnerId6D = @uid WHERE Id = ${todayGame.Id}`);
            } else if (matchedPairs > 0) {
                isWinner = true; payoutKip = matchedPairs * settings.PartialPrize6D; message = `🎉 ยินดีด้วย! คุณทายถูก ${matchedPairs} คู่ (ระบบได้เปลี่ยนเลขคู่ที่คุณทายถูกแล้ว!)`;
                const regenerated6D = `${newWinFront}${newWinMid}${newWinBack}`;
                await (new sql.Request(transaction)).input('new6D', sql.VarChar, regenerated6D).query(`UPDATE DailyWinningNumbers SET WinNumber6D = @new6D WHERE Id = ${todayGame.Id}`);
            }
        } else {
            if (guessNumber === todayGame[winNumCol]) {
                isWinner = true; 
                payoutKip = settings[`CurrentJackpot${gameType}`]; // 🌟 เปลี่ยนมาจ่ายเงินตามยอดสะสม
                message = "🎉 ยินดีด้วย! คุณคือผู้โชคดี แจ็คพ็อตแตก!!";
                await (new sql.Request(transaction)).input('uid', sql.Int, userId).query(`UPDATE DailyWinningNumbers SET ${isWonCol} = 1, ${winnerIdCol} = @uid WHERE Id = ${todayGame.Id}`);
            }
        }

        let payoutAmount = 0;
        if (isWinner && payoutKip > 0) {
            const userRes = await (new sql.Request(transaction)).input('uid', sql.Int, userId).query(`SELECT Country FROM UsersRegister WHERE Id = @uid`);
            const isThai = userRes.recordset[0].Country.includes("Thailand");
            payoutAmount = isThai ? (payoutKip / 666) : payoutKip; 
            await (new sql.Request(transaction)).input('uid', sql.Int, userId).input('payout', sql.Decimal, payoutAmount).query(`UPDATE Wallets SET Balance = Balance + @payout WHERE UserId = @uid`);
            await (new sql.Request(transaction)).input('uid', sql.Int, userId).input('payout', sql.Decimal, payoutAmount).query(`INSERT INTO Transactions (UserId, TransactionType, Amount, Status, ReferenceId) VALUES (@uid, 'GAME_PRIZE', @payout, 'COMPLETED', 'JACKPOT_${gameType}')`);
        }

        await (new sql.Request(transaction)).input('uid', sql.Int, userId).input('guess', sql.VarChar, guessNumber).input('isFree', sql.Bit, isFreePlay ? 1 : 0).input('isWon', sql.Bit, isWinner ? 1 : 0).query(`INSERT INTO SoiDaoPlayLogs (UserId, IsFreePlay, Number${gameType}, IsWon) VALUES (@uid, @isFree, @guess, @isWon)`);
        await transaction.commit();
        res.json({ success: true, isWinner: isWinner, message: message, payoutAmount: payoutAmount });
    } catch (err) {
        await transaction.rollback(); res.status(400).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: จำลองการขึ้นวันใหม่ (ทบยอดของรางวัลทุกประเภท!)
// ==============================================================
app.post('/api/game/trigger-new-day', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const todayRes = await pool.request().query(`SELECT * FROM DailyWinningNumbers WHERE GameDate = CAST(GETDATE() AS DATE)`);
        
        if (todayRes.recordset.length > 0) {
            const today = todayRes.recordset[0];
            
            // ลอจิก: ถ้าคนไม่ถูก (false/0) ให้เอาฐานเดิมบวกยอดสะสมปัจจุบัน | ถ้าคนถูกแล้ว ให้รีเซ็ตเป็นฐานเดิม
            let update2D = (today.IsWon2D === true || today.IsWon2D === 1) ? "Prize2D" : "ISNULL(CurrentJackpot2D, 0) + Prize2D";
            let update3D = (today.IsWon3D === true || today.IsWon3D === 1) ? "Prize3D" : "ISNULL(CurrentJackpot3D, 0) + Prize3D";
            let update4D = (today.IsWon4D === true || today.IsWon4D === 1) ? "Prize4D" : "ISNULL(CurrentJackpot4D, 0) + Prize4D";
            let update6D = (today.IsWon6D === true || today.IsWon6D === 1) ? "Prize6D_Base" : "ISNULL(CurrentJackpot6D, 0) + Prize6D_Base";

            await pool.request().query(`
                UPDATE GamePrizeSettings 
                SET CurrentJackpot2D = ${update2D},
                    CurrentJackpot3D = ${update3D},
                    CurrentJackpot4D = ${update4D},
                    CurrentJackpot6D = ${update6D}
                WHERE Id = 1
            `);
        }

        await pool.request().query(`DELETE FROM DailyWinningNumbers WHERE GameDate = CAST(GETDATE() AS DATE)`);
        const win2D = Math.floor(Math.random() * 100).toString().padStart(2, '0');
        const win3D = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const win4D = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
        const win6D = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');

        await pool.request().query(`
            INSERT INTO DailyWinningNumbers (WinNumber2D, WinNumber3D, WinNumber4D, WinNumber6D, GameDate)
            VALUES ('${win2D}', '${win3D}', '${win4D}', '${win6D}', CAST(GETDATE() AS DATE))
        `);

        res.json({ success: true, message: `ข้ามวันและทำการคำนวณทบยอดสะสมของทุกรางวัลเรียบร้อยแล้ว!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: ดึงข้อมูลหน้ากระเป๋าเงิน (แก้ปัญหา Statement ใหม่ไม่ขึ้น)
// ==============================================================
// ==============================================================
// 🌟 API: ดึงข้อมูลหน้ากระเป๋าเงิน (รับค่า username แทน userId)
// ==============================================================
app.get('/api/wallet/assets/:username', async (req, res) => {
    const username = req.params.username; 
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    const offset = (page - 1) * limit;

    try {
        let pool = await sql.connect(config);
        
        // 0. ค้นหา UserId ด้วย Username ที่ส่งมา
        const userRes = await pool.request()
            .input('username', sql.VarChar, username)
            .query(`SELECT Id FROM UsersRegister WHERE Username = @username`);
            
        if (userRes.recordset.length === 0) return res.status(404).json({ success: false, message: "User not found" });
        
        const userId = userRes.recordset[0].Id; 

        // 1. ดึงกระเป๋าเงิน
        const walletRes = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`SELECT Balance, Currency, LastUpdated FROM Wallets WHERE UserId = @userId`);
            
        let wallet = { Balance: 0, Currency: 'THB', LastUpdated: new Date() };
        if (walletRes.recordset.length > 0) wallet = walletRes.recordset[0];

        // 🌟 2. ดึง Statement (ไม่มีคำว่า Currency ใน SELECT แล้ว)
        const txRes = await pool.request()
            .input('userId', sql.Int, userId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT 
                    Id, 
                    Amount, 
                    TransactionType, 
                    Status, 
                    COALESCE(CreatedAt, TransactionDate, GETDATE()) AS CreatedAt, 
                    ReferenceId
                FROM Transactions 
                WHERE UserId = @userId 
                ORDER BY COALESCE(CreatedAt, TransactionDate, GETDATE()) DESC 
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
            `);

        res.json({ 
            success: true, 
            balance: wallet.Balance, 
            currency: wallet.Currency,      
            lastUpdated: wallet.LastUpdated, 
            transactions: txRes.recordset,
            totalPages: 1 
        });
    } catch (err) {
        console.error("🔥 Assets API Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/countries', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        let result = await pool.request().query("SELECT * FROM Countries ORDER BY Id DESC");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// 2. เพิ่มประเทศใหม่
// 2. เพิ่มประเทศใหม่ (รองรับรูปธงชาติ)
app.post('/add-country', async (req, res) => {
    const { countryCode, countryName, flagImageUrl, phonePrefix } = req.body; // <--- เพิ่ม flagImageUrl ตรงนี้
    try {
        let pool = await sql.connect(config);
        await pool.request()
            .input('code', sql.VarChar, countryCode)
            .input('name', sql.NVarChar, countryName)
            .input('flag', sql.VarChar, flagImageUrl || '') // <--- รับค่าธงชาติ (ถ้าไม่ใส่จะให้เป็นค่าว่าง)
            .input('prefix', sql.VarChar, phonePrefix || '') // 2. รับรหัสโทรศัพท์
            .query("INSERT INTO Countries (CountryCode, CountryName, FlagImageUrl, PhonePrefix, Status) VALUES (@code, @name, @flag, @prefix, 'Active')"); // <--- เพิ่ม FlagImageUrl ลงในคำสั่ง Insert
        res.json({ message: "เพิ่มประเทศสำเร็จ" });
    } catch (err) {
        if (err.message.includes('UNIQUE KEY constraint')) {
            return res.status(400).json({ error: "รหัสประเทศนี้มีอยู่ในระบบแล้ว" });
        }
        res.status(500).json({ error: err.message });
    }
});

// API สำหรับอัปเดตข้อมูลประเทศ (สำหรับโหมดแก้ไข)
app.put('/update-country/:id', async (req, res) => {
    const { id } = req.params;
    const { countryCode, countryName, flagImageUrl, phonePrefix } = req.body;
    
    try {
        let pool = await sql.connect(config);
        await pool.request()
            .input('id', sql.Int, id)
            .input('code', sql.VarChar, countryCode)
            .input('name', sql.NVarChar, countryName)
            .input('flag', sql.VarChar, flagImageUrl || '')
            .input('prefix', sql.VarChar, phonePrefix || '')
            .query(`
                UPDATE Countries 
                SET CountryCode = @code, CountryName = @name, FlagImageUrl = @flag, PhonePrefix = @prefix 
                WHERE Id = @id
            `);
            
        res.json({ message: "อัปเดตข้อมูลสำเร็จ" });
    } catch (err) {
        if (err.message.includes('UNIQUE KEY constraint')) {
            return res.status(400).json({ error: "รหัสประเทศนี้มีอยู่ในระบบแล้ว" });
        }
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 1. API สำหรับสมัครสมาชิก (ใช้งานกับตาราง UsersRegister)
// ==============================================================
// ตัวอย่างการแก้ API Register (Node.js)
app.post('/register', async (req, res) => {
    // 🌟 รับค่า referralUsername มาจากหน้าบ้านด้วย
    const { username, password, country, referralUsername } = req.body; 
    
    try {
        let pool = await sql.connect(config);
        
        // ... (โค้ดเช็กว่าชื่อซ้ำไหม ของคุณที่มีอยู่เดิม) ...

        // 🌟 แก้คำสั่ง INSERT ให้เพิ่ม ReferralUsername เข้าไป
        await pool.request()
            .input('user', sql.VarChar, username)
            .input('pass', sql.VarChar, password)
            .input('country', sql.VarChar, country)
            .input('ref', sql.VarChar, referralUsername || null) // ถ้าไม่มีคนแนะนำให้ใส่ null
            .query(`
                INSERT INTO UsersRegister (Username, Password, Country, ReferralUsername, Status, RegistrationDate) 
                VALUES (@user, @pass, @country, @ref, 'Active', GETDATE())
            `);
            
        res.json({ success: true, message: "สมัครสมาชิกสำเร็จ!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 3. API สำหรับตรวจสอบชื่อผู้แนะนำ (และดึงชื่อ-สกุลจริงจาก UserNames)
// ==============================================================
app.post('/check-referral', async (req, res) => {
    const { referralUsername } = req.body;
    
    try {
        let pool = await sql.connect(config);
        
        // 🌟 อัปเดต: ใช้ LOWER() เพื่อแปลงเป็นตัวเล็กทั้งหมด และ TRIM() เพื่อตัดช่องว่าง
        let result = await pool.request()
            .input('user', sql.VarChar, referralUsername)
            .query(`
                SELECT 
                    R.Username, 
                    N.FirstName, 
                    N.LastName 
                FROM UsersRegister R
                LEFT JOIN UserNames N ON LOWER(TRIM(R.Username)) = LOWER(TRIM(N.Username)) AND N.Status = 'Active'
                WHERE LOWER(TRIM(R.Username)) = LOWER(TRIM(@user)) AND TRIM(R.Status) = 'Active'
            `);

        if (result.recordset.length > 0) {
            const userData = result.recordset[0];
            
            let fullName = "ยังไม่ได้ระบุชื่อ-สกุล";
            if (userData.FirstName || userData.LastName) {
                fullName = `${userData.FirstName || ''} ${userData.LastName || ''}`.trim();
            }

            res.json({ 
                found: true, 
                message: `ผู้แนะนำ: คุณ ${fullName}` 
            });
        } else {
            res.json({ found: false, message: "ไม่พบรหัสผู้แนะนำนี้ในระบบ" });
        }
    } catch (err) {
        console.error("Check Referral Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 3.5 API สำหรับตรวจสอบ Username ซ้ำแบบ Real-time
// ==============================================================
app.post('/check-username', async (req, res) => {
    const { username } = req.body;
    try {
        let pool = await sql.connect(config);
        
        // ค้นหาว่ามีคนใช้ชื่อนี้ไปหรือยัง
        let result = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT Id FROM UsersRegister WHERE Username = @user");

        if (result.recordset.length > 0) {
            // เจอข้อมูล = ไม่ว่าง (ซ้ำ)
            res.json({ available: false, message: "ชื่อผู้ใช้งานนี้มีคนใช้แล้ว กรุณาเปลี่ยนใหม่" });
        } else {
            // ไม่เจอข้อมูล = ว่าง (ใช้ได้)
            res.json({ available: true, message: "ชื่อผู้ใช้งานนี้สามารถใช้ได้" });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});




app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    console.log("มีคนพยายาม Login ด้วยชื่อ:", username); 
    try {
        let pool = await sql.connect(config);
        let result = await pool.request()
            .input('user', sql.VarChar, username)
            .input('pass', sql.VarChar, password)
            .query("SELECT * FROM UsersRegister WHERE Username = @user AND Password = @pass AND Status = 'Active'");

        if (result.recordset.length > 0) {
            const userData = result.recordset[0]; 
            
            // 🟢 ส่งข้อมูลกลับไปให้ Frontend (เพิ่ม Id เข้าไปด้วย!)
            res.json({ 
                message: "Login สำเร็จ",
                id: userData.Id,             // 🌟 เพิ่มบรรทัดนี้: ส่ง Id กลับไปให้ Frontend
                username: userData.Username,
                country: userData.Country    
            });
        } else {
            console.log("หาข้อมูลไม่เจอใน Database หรือรหัสผิด"); 
            res.status(401).send('ข้อมูลผิดพลาด');
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: ดึงข้อมูลหน้ากระเป๋าเงิน (เวอร์ชันปลอดภัยสูงสุด กัน Error 500)
// ==============================================================
app.get('/api/wallet/assets/:username', async (req, res) => {
    const username = req.params.username; 
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20; 
    const offset = (page - 1) * limit;

    try {
        let pool = await sql.connect(config);
        
        // 0. ค้นหา UserId
        const userRes = await pool.request()
            .input('username', sql.VarChar, username)
            .query(`SELECT Id FROM UsersRegister WHERE Username = @username`);
            
        if (userRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        
        const userId = userRes.recordset[0].Id; 

        // 1. ดึงกระเป๋าเงิน
        const walletRes = await pool.request()
            .input('userId', sql.Int, userId)
            .query(`SELECT Balance, Currency, LastUpdated FROM Wallets WHERE UserId = @userId`);
            
        let wallet = { Balance: 0, Currency: 'THB', LastUpdated: new Date() };
        if (walletRes.recordset.length > 0) {
            wallet = walletRes.recordset[0];
        }

        // 🌟 2. ดึง Statement (ใช้ COALESCE ป้องกันวันที่เป็น NULL ที่ทำให้ระบบพัง)
        const txRes = await pool.request()
            .input('userId', sql.Int, userId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT 
                    Id, 
                    Amount, 
                    TransactionType, 
                    Status, 
                    COALESCE(CreatedAt, TransactionDate, GETDATE()) AS CreatedAt, 
                    ReferenceId,
                    Currency
                FROM Transactions 
                WHERE UserId = @userId 
                ORDER BY COALESCE(CreatedAt, TransactionDate, GETDATE()) DESC 
                OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
            `);

        res.json({ 
            success: true, 
            balance: wallet.Balance, 
            currency: wallet.Currency,      
            lastUpdated: wallet.LastUpdated, 
            transactions: txRes.recordset,
            totalPages: 1 
        });
    } catch (err) {
        // 🌟 พิมพ์ Error ออกมาดูชัดๆ ในหน้าต่าง Console ฝั่ง Node.js
        console.error("🔥 Assets API Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 1. API: ดึงข้อมูลหน้า Profile (สถิติ, ประวัติการเล่น, ข้อมูลส่วนตัว)
// ==============================================================
app.get('/api/user/profile-stats', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        
        // 1. ดึงข้อมูล User เบื้องต้น
        const userRes = await pool.request().input('user', sql.VarChar, username).query(`SELECT Id, RegistrationDate FROM UsersRegister WHERE Username = @user`);
        if (userRes.recordset.length === 0) return res.status(404).json({ error: "ไม่พบผู้ใช้งาน" });
        const userId = userRes.recordset[0].Id;
        const regDate = new Date(userRes.recordset[0].RegistrationDate);

        // 2. คำนวณวันหมดอายุ 30 วัน
        const expiryDate = new Date(regDate);
        expiryDate.setDate(expiryDate.getDate() + 30);
        const today = new Date();
        const diffTime = expiryDate - today;
        const daysLeft = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
        const isEligible = daysLeft > 0;

        // 3. ดึงจำนวนตั๋วฟรีวันนี้
        const ticketRes = await pool.request().input('uid', sql.Int, userId).query(`SELECT FreeTickets FROM UserGameTickets WHERE UserId = @uid`);
        const freeTicketsToday = ticketRes.recordset.length > 0 ? ticketRes.recordset[0].FreeTickets : 0;

        // 4. ดึงประวัติการเล่น "สอยดาว" ทั้งหมด (ดึงจาก UserGameHistory)
        const historyRes = await pool.request().input('uid', sql.Int, userId).query(`
            SELECT TOP 10 GameType, IsFreeTicket, PlayDate, PlayTime, ResultStatus, RewardAmount 
            FROM UserGameHistory WHERE UserId = @uid ORDER BY PlayDate DESC, PlayTime DESC
        `);

       // 5. ดึงข้อมูลส่วนตัว (แบ่งดึงจาก 2 ตารางเพื่อความชัวร์)
        // 5.1 ดึงรูปภาพและเบอร์โทร (จาก UserProfiles)
        const profileRes = await pool.request().input('user', sql.VarChar, username).query(`
            SELECT ProfileImageUrl, PhoneNumber, IsPhoneVerified FROM UserProfiles WHERE Username = @user
        `);
        let profileData = profileRes.recordset.length > 0 ? profileRes.recordset[0] : { ProfileImageUrl: null, PhoneNumber: '', IsPhoneVerified: false };

        // 5.2 ดึงชื่อ-นามสกุล ล่าสุด (จาก UserNames ที่เพิ่งบันทึกลงไป)
        const nameRes = await pool.request().input('user', sql.VarChar, username).query(`
            SELECT TOP 1 FirstName, LastName FROM UserNames WHERE Username = @user AND Status = 'Active' ORDER BY CreatedAt DESC
        `);
        
        // เอาชื่อมาประกอบร่างใส่ใน profileData
        if (nameRes.recordset.length > 0) {
            profileData.FirstName = nameRes.recordset[0].FirstName;
            profileData.LastName = nameRes.recordset[0].LastName;
        } else {
            profileData.FirstName = '';
            profileData.LastName = '';
        }

       // 🌟 [แก้ไขแล้ว] ดึงประวัติบัญชีธนาคาร (รองรับทั้ง Active และ APPROVED)
       const bankRes = await pool.request().input('user', sql.VarChar, username).query(`
           SELECT BankName, AccountNumber, AccountName, BankLogo 
           FROM UserBankAccounts 
           WHERE Username = @user AND (Status = 'Active' OR Status = 'APPROVED')
       `);
        const bankData = bankRes.recordset.length > 0 ? bankRes.recordset[0] : null;

        res.json({
            success: true,
            stats: { daysLeft, isEligible, freeTicketsToday, gameHistory: historyRes.recordset },
            profile: profileData || { ProfileImageUrl: null, FirstName: '', LastName: '', PhoneNumber: '', IsPhoneVerified: false },
            bank: bankData || { BankName: '', AccountNumber: '', AccountName: '' }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: อัปเดตข้อมูลส่วนตัว (รูปโปรไฟล์, เบอร์โทร และ ชื่อ-นามสกุล)
// ==============================================================
app.post('/api/user/update-profile', async (req, res) => {
    const { username, imageBase64, firstName, lastName, phone } = req.body;

    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        
        // 🌟 เริ่ม Transaction เพื่อให้มั่นใจว่าข้อมูลบันทึกลงทั้ง 2 ตารางอย่างปลอดภัย
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // -----------------------------------------------------
            // 1. จัดการตาราง UserProfiles (บันทึก รูปภาพ และ เบอร์โทร)
            // -----------------------------------------------------
            const profileCheck = await transaction.request()
                .input('user', sql.VarChar, username)
                .query(`SELECT Id FROM UserProfiles WHERE Username = @user`);

            if (profileCheck.recordset.length > 0) {
                // มีข้อมูลแล้ว ให้อัปเดต (ถ้าอันไหนไม่ได้ส่งมา ให้คงค่าเดิมไว้ด้วย ISNULL)
                await transaction.request()
                    .input('user', sql.VarChar, username)
                    .input('img', sql.NVarChar(sql.MAX), imageBase64 || null)
                    .input('phone', sql.VarChar, phone || null)
                    .query(`
                        UPDATE UserProfiles 
                        SET 
                            ProfileImageUrl = ISNULL(@img, ProfileImageUrl), 
                            PhoneNumber = ISNULL(@phone, PhoneNumber) 
                        WHERE Username = @user
                    `);
            } else {
                // ยังไม่มี ให้เพิ่มใหม่
                await transaction.request()
                    .input('user', sql.VarChar, username)
                    .input('img', sql.NVarChar(sql.MAX), imageBase64 || '')
                    .input('phone', sql.VarChar, phone || '')
                    .query(`INSERT INTO UserProfiles (Username, ProfileImageUrl, PhoneNumber) VALUES (@user, @img, @phone)`);
            }

            // -----------------------------------------------------
            // 2. จัดการตาราง UserNames (บันทึก ชื่อ-นามสกุล และบังคับ Status = 'Active')
            // -----------------------------------------------------
            if (firstName !== undefined && lastName !== undefined) {
                const nameCheck = await transaction.request()
                    .input('user', sql.VarChar, username)
                    .query(`SELECT Id FROM UserNames WHERE Username = @user`);

                if (nameCheck.recordset.length > 0) {
                    // มีข้อมูลแล้ว ให้อัปเดตและบังคับ Active
                    await transaction.request()
                        .input('user', sql.VarChar, username)
                        .input('fname', sql.NVarChar, firstName)
                        .input('lname', sql.NVarChar, lastName)
                        .query(`UPDATE UserNames SET FirstName = @fname, LastName = @lname, Status = 'Active' WHERE Username = @user`);
                } else {
                    // ยังไม่มี ให้เพิ่มใหม่และบังคับ Active
                    await transaction.request()
                        .input('user', sql.VarChar, username)
                        .input('fname', sql.NVarChar, firstName)
                        .input('lname', sql.NVarChar, lastName)
                        .query(`INSERT INTO UserNames (Username, FirstName, LastName, Status, CreatedAt) VALUES (@user, @fname, @lname, 'Active', GETDATE())`);
                }
            }

            await transaction.commit();
            res.json({ success: true, message: "บันทึกข้อมูลส่วนตัวสำเร็จ" });

        } catch (err) {
            await transaction.rollback();
            throw err;
        }

    } catch (err) {
        console.error("🔥 Update Profile Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 [แยก API เฉพาะ] สำหรับบันทึกบัญชีธนาคารผู้ใช้ (Insert ใหม่, ของเก่า Inactive)
// ==============================================================
app.post('/api/user/bank', async (req, res) => {
    const { username, bankCode, accNumber, accName } = req.body;
    
    if (!username || !bankCode || !accNumber || !accName) {
        return res.status(400).json({ error: "กรุณากรอกข้อมูลบัญชีธนาคารให้ครบถ้วน" });
    }
    
    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // สเต็ปที่ 1: เปลี่ยนสถานะบัญชีเดิมทั้งหมดของ User นี้ ให้เป็น 'Inactive' (เพื่อเก็บเป็นประวัติย้อนหลัง)
            await transaction.request()
                .input('user', sql.VarChar, username)
                .query(`UPDATE UserBankAccounts SET Status = 'Inactive' WHERE Username = @user`);

            // Mapped ข้อมูลจากตาราง SystemBanks เพื่อเอาชื่อธนาคารเต็มมาบันทึก
            const bankMasterRes = await transaction.request()
                .input('bcode', sql.VarChar, bankCode)
                .query(`SELECT BankName FROM SystemBanks WHERE BankCode = @bcode`);
            
            const fullBankName = bankMasterRes.recordset.length > 0 ? bankMasterRes.recordset[0].BankName : bankCode;

            // สเต็ปที่ 2: Insert บัญชีใหม่เข้าตาราง โดยตั้งสถานะเป็น 'Active' เสมอ
            await transaction.request()
                .input('user', sql.VarChar, username)
                .input('bname', sql.NVarChar, fullBankName)
                .input('accno', sql.VarChar, accNumber)
                .input('accname', sql.NVarChar, accName)
                .query(`
                    INSERT INTO UserBankAccounts (Username, BankName, AccountNumber, AccountName, IsVerified, Status, CreatedAt) 
                    VALUES (@user, @bname, @accno, @accname, 0, 'Active', GETUTCDATE())
                `);

            await transaction.commit();
            res.json({ success: true, message: "🎁 บันทึกบัญชีธนาคารใหม่สำเร็จ และเก็บประวัติบัญชีเก่าเรียบร้อยแล้ว!" });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API ดึงรายชื่อธนาคาร คัดกรองตามประเทศ (TH/LA) ของ User
// ==============================================================
app.get('/api/system/banks', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);

        // 1. ตรวจสอบสัญชาติ (Country) ของ User จากตาราง UsersRegister
        const userRes = await pool.request()
            .input('user', sql.VarChar, username)
            .query(`SELECT Country FROM UsersRegister WHERE Username = @user`);

        // ตั้งค่าเริ่มต้นเป็น 'TH' (ไทย) ไว้ก่อนเผื่อหาข้อมูลไม่พบ
        let userCountry = 'TH'; 
        if (userRes.recordset.length > 0 && userRes.recordset[0].Country) {
            userCountry = userRes.recordset[0].Country;
        }

        // 2. ดึงรายชื่อธนาคารและโลโก้ เฉพาะที่ตรงกับประเทศ (Country) ของ User และเปิดใช้งานอยู่ (IsActive = 1)
        const result = await pool.request()
            .input('country', sql.VarChar, userCountry)
            .query(`
                SELECT BankCode, BankName, BankLogo 
                FROM SystemBanks 
                WHERE IsActive = 1 AND Country = @country
            `);

        res.json({ success: true, banks: result.recordset });
    } catch (err) {
        console.error("Fetch Banks Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});
// ==============================================================
// 🌟 [FRONTEND API] ลูกค้าเพิ่มบัญชีธนาคาร พร้อมแนบรูปสมุดบัญชี (รอ KYC)
// ==============================================================
app.post('/api/user/bank', async (req, res) => {
    // 🌟 รับค่า bankBookImage เพิ่มเข้ามา
    const { username, bankCode, accNumber, accName, bankBookImage } = req.body;
    
    if (!username || !bankCode || !accNumber || !accName || !bankBookImage) {
        return res.status(400).json({ error: "กรุณากรอกข้อมูลและอัปโหลดรูปสมุดบัญชีให้ครบถ้วน" });
    }
    
    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 1. เปลี่ยนสถานะบัญชีเดิมของลูกค้าเป็น Inactive (เก็บเป็นประวัติ)
            await transaction.request()
                .input('user', sql.VarChar, username)
                .query(`UPDATE UserBankAccounts SET Status = 'Inactive' WHERE Username = @user`);

            // 2. ดึงชื่อเต็มและโลโก้มาจาก SystemBanks
            const bankMasterRes = await transaction.request()
                .input('bcode', sql.VarChar, bankCode)
                .query(`SELECT BankName, BankLogo FROM SystemBanks WHERE BankCode = @bcode`);
            
            const fullBankName = bankMasterRes.recordset.length > 0 ? bankMasterRes.recordset[0].BankName : bankCode;
            const bankLogoPath = bankMasterRes.recordset.length > 0 ? bankMasterRes.recordset[0].BankLogo : null;

            // 3. บันทึกบัญชีใหม่ พร้อมรูปสมุดบัญชี (ตั้ง IsVerified = 0 คือ รออนุมัติ)
            await transaction.request()
                .input('user', sql.VarChar, username)
                .input('bname', sql.NVarChar, fullBankName)
                .input('accno', sql.VarChar, accNumber)
                .input('accname', sql.NVarChar, accName)
                .input('blogo', sql.VarChar, bankLogoPath)
                .input('bookImg', sql.VarChar(sql.MAX), bankBookImage) // 🌟 บันทึกรูปลง DB
                .query(`
                    INSERT INTO UserBankAccounts (Username, BankName, AccountNumber, AccountName, IsVerified, Status, CreatedAt, BankLogo, BankBookImage) 
                    VALUES (@user, @bname, @accno, @accname, 0, 'Active', GETUTCDATE(), @blogo, @bookImg)
                `);

            await transaction.commit();
            res.json({ success: true, message: "ส่งข้อมูลบัญชีเพื่อตรวจสอบเรียบร้อยแล้ว กรุณารอแอดมินอนุมัติครับ!" });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// API สำหรับ Admin Login (ฝั่งพนักงาน)
// ==============================================================
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        let pool = await sql.connect(config);
        
        // ค้นหาข้อมูลจากตาราง Employees
        const result = await pool.request()
            .input('u', sql.VarChar, username)
            .input('p', sql.VarChar, password)
            .query(`SELECT EmployeeCode, Username, FirstName, LastName, Role
                    FROM Employees 
                    WHERE Username = @u AND Password = @p AND Status = 'Active'`);

        if (result.recordset.length > 0) {
            // ถ้าเจอ ให้ส่งข้อมูลกลับไป
            res.json({ success: true, user: result.recordset[0] });
        } else {
            // ถ้าไม่เจอ (รหัสผิด)
            res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
        }
    } catch (err) {
        console.error("Admin Login Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: ดึงประวัติรายการเฉพาะของ User นั้นๆ (หน้า Assets)4444444
// ==============================================================
app.get('/api/user/statements', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        
        // 1. หา UserId ก่อน
        const userRes = await pool.request()
            .input('user', sql.VarChar, username)
            .query(`SELECT Id FROM UsersRegister WHERE Username = @user`);
            
        if (userRes.recordset.length === 0) return res.status(404).json({ error: "ไม่พบผู้ใช้งาน" });
        const userId = userRes.recordset[0].Id;

        // 2. ดึงประวัติเกม เฉพาะของ UserId นี้เท่านั้น
        const result = await pool.request()
            .input('uid', sql.Int, userId)
            .query(`
                SELECT * FROM UserGameHistory 
                WHERE UserId = @uid 
                ORDER BY PlayDate DESC, PlayTime DESC
            `);
            
        res.json({ success: true, statements: result.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/wallet/transfer', async (req, res) => {
    const { fromUserId, toUserId, amount } = req.body;
    let pool = await sql.connect(config);
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin(); // เริ่มต้น Transaction
        
        // 1. ตรวจสอบยอดเงิน (Lock ข้อมูลแถวนั้นไว้ด้วยคำสั่ง UPDLOCK)
        const balanceCheck = await transaction.request()
            .input('uid', sql.Int, fromUserId)
            .query(`SELECT Balance FROM Wallets WITH (UPDLOCK) WHERE UserId = @uid`);

        if (balanceCheck.recordset[0].Balance < amount) {
            throw new Error("ยอดเงินไม่เพียงพอ");
        }

        // 2. หักเงินผู้โอน
        await transaction.request()
            .input('uid', sql.Int, fromUserId)
            .input('amt', sql.Decimal, amount)
            .query(`UPDATE Wallets SET Balance = Balance - @amt WHERE UserId = @uid`);

        // 3. เพิ่มเงินผู้รับ
        await transaction.request()
            .input('uid', sql.Int, toUserId)
            .input('amt', sql.Decimal, amount)
            .query(`UPDATE Wallets SET Balance = Balance + @amt WHERE UserId = @uid`);

        // 4. บันทึกประวัติ
        await transaction.request()
            .input('uid', sql.Int, fromUserId)
            .input('amt', sql.Decimal, amount)
            .query(`INSERT INTO Transactions (UserId, Type, Amount, Status) VALUES (@uid, 'TRANSFER', @amt, 'COMPLETED')`);

        await transaction.commit(); // ยืนยันสำเร็จ
        res.json({ success: true, message: "โอนเงินสำเร็จ" });
    } catch (err) {
        await transaction.rollback(); // ถ้าพัง ให้ยกเลิกการหักเงินทั้งหมด
        res.status(400).json({ error: err.message });
    }
});

// ==============================================================
// API: ดึงข้อมูลกระเป๋าเงิน (Wallet Balance)
// ==============================================================
app.get('/api/wallet/balance', async (req, res) => {
    const { userId } = req.query; 
    
    try {
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('uid', sql.Int, userId)
            .query(`SELECT Balance, Currency FROM Wallets WHERE UserId = @uid`);

        if (result.recordset.length > 0) {
            // ถ้ามีกระเป๋าเงิน ให้ส่งข้อมูลกลับไป
            res.json(result.recordset[0]);
        } else {
            // ถ้ายังไม่มี ให้ดึงยอดเป็น 0 อัตโนมัติ
            res.json({ Balance: 0, Currency: 'THB' });
        }
    } catch (err) {
        console.error("Wallet API Error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API (Admin): 1. รับยอดจาก Manager และกระทบยอดอัตโนมัติ
// ==============================================================
app.post('/api/admin/statements', async (req, res) => {
    // รับค่าที่ Manager พิมพ์เข้ามา
    const { systemBankId, amount, transferDate, transferTime, adminName } = req.body;

    if (!systemBankId || !amount || !transferDate || !adminName) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน กรุณากรอกให้ครบ" });
    }

    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 1. บันทึก Statement ลงฐานข้อมูลก่อน (สถานะเริ่มต้นคือ 'UNMATCHED' = ยังไม่จับคู่)
            const insertStmt = await transaction.request()
                .input('bankId', sql.Int, systemBankId)
                .input('amount', sql.Decimal(18,2), amount)
                .input('tDate', sql.Date, transferDate)
                .input('tTime', sql.VarChar, transferTime)
                .input('admin', sql.NVarChar, adminName)
                .query(`
                    INSERT INTO SystemStatements (SystemBankId, Amount, TransferDate, TransferTime, KeyedByAdmin, Status)
                    OUTPUT INSERTED.Id
                    VALUES (@bankId, @amount, @tDate, @tTime, @admin, 'UNMATCHED')
                `);
            
            const statementId = insertStmt.recordset[0].Id;

            // 2. 🔍 ค้นหาบิลของผู้เล่นที่ "รอตรวจสอบ" และมีข้อมูลตรงกันเป๊ะๆ (ธนาคาร, วันที่, ยอดเงิน)
            const findMatch = await transaction.request()
                .input('bankId', sql.Int, systemBankId)
                .input('amount', sql.Decimal(18,2), amount)
                .input('tDate', sql.Date, transferDate)
                .query(`
                    SELECT TOP 1 * FROM Transactions 
                    WHERE TransactionType = 'DEPOSIT' 
                    AND Status = 'PENDING'
                    AND SystemBankId = @bankId 
                    AND Amount = @amount 
                    AND TransferDate = @tDate
                    ORDER BY CreatedAt ASC
                `);

            let matchResult = "บันทึก Statement สำเร็จ (รอผู้เล่นแจ้งโอนเงินเพื่อจับคู่)";

            // 3. ถ้าเจอข้อมูลตรงกัน (Match!) -> ดำเนินการเติมเงินอัตโนมัติ
            if (findMatch.recordset.length > 0) {
                const matchedTx = findMatch.recordset[0];
                const userId = matchedTx.UserId;
                const txId = matchedTx.Id;

                // 3.1 เปลี่ยนสถานะบิลผู้เล่นเป็น COMPLETED และบันทึกว่าใครอนุมัติ
                await transaction.request()
                    .input('txId', sql.Int, txId)
                    .input('admin', sql.VarChar, adminName)
                    .query(`UPDATE Transactions SET Status = 'COMPLETED', ApprovedByAdmin = @admin WHERE Id = @txId`);

                // 3.2 เปลี่ยนสถานะ Statement เป็น MATCHED
                await transaction.request()
                    .input('stmtId', sql.Int, statementId)
                    .query(`UPDATE SystemStatements SET Status = 'MATCHED' WHERE Id = @stmtId`);

               // 3.3 💰 เติมเงินเข้ากระเป๋า Wallet ผู้เล่น (รองรับผู้ใช้ใหม่)
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('amt', sql.Decimal(18,4), amount)
                    .query(`
                        IF EXISTS (SELECT 1 FROM Wallets WHERE UserId = @uid)
                        BEGIN
                            UPDATE Wallets 
                            SET Balance = ISNULL(Balance, 0) + @amt, LastUpdated = GETDATE() 
                            WHERE UserId = @uid;
                        END
                        ELSE
                        BEGIN
                            INSERT INTO Wallets (UserId, Balance, Currency, LastUpdated)
                            VALUES (@uid, @amt, 'THB', GETDATE());
                        END
                    `);

                // 3.4 แจ้งเตือนผู้เล่น
                const userRes = await transaction.request()
                    .input('uid', sql.Int, userId)
                    .query(`SELECT Username FROM UsersRegister WHERE Id = @uid`);
                
                if(userRes.recordset.length > 0) {
                    const username = userRes.recordset[0].Username;
                    await transaction.request()
                        .input('user', sql.VarChar, username)
                        .input('title', sql.NVarChar, 'กระทบยอดอัตโนมัติสำเร็จ')
                        .input('msg', sql.NVarChar, `ยอดเงิน ${amount} บาท เข้า Wallet เรียบร้อยแล้ว`)
                        .query(`INSERT INTO Notifications (Username, Title, Message) VALUES (@user, @title, @msg)`);
                }

                matchResult = "✅ บันทึกและจับคู่สำเร็จ! ระบบเติมเงินให้ผู้เล่นอัตโนมัติแล้ว";
            }

            await transaction.commit();
            res.json({ success: true, message: matchResult });

        } catch (err) {
            await transaction.rollback();
            throw err;
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API (Admin): 2. ดึงประวัติ Statement ทั้งหมดมาแสดงเป็นตาราง
// ==============================================================
app.get('/api/admin/statements', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request().query(`
            SELECT * FROM SystemStatements 
            ORDER BY TransferDate DESC, TransferTime DESC, CreatedAt DESC
        `);
        res.json({ success: true, statements: result.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API (User): ดึงข้อมูล Profile, นับเวลาถอยหลัง 30 วัน และสิทธิ์ฟรีรายวัน
// ==============================================================
app.get('/api/user/profile-stats', async (req, res) => {
    // สมมติว่าเรารับ username หรือ userId มาจาก Token/Session 
    // ในที่นี้ผมขอรับผ่าน query string ก่อนเพื่อความง่ายในการทดสอบ เช่น ?username=Admin
    const { username } = req.query; 

    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        
        // 1. ดึงข้อมูล User และวันที่สมัคร
        const userResult = await pool.request()
            .input('user', sql.VarChar, username)
            .query("SELECT Id, RegistrationDate FROM UsersRegister WHERE Username = @user");
            
        if (userResult.recordset.length === 0) return res.status(404).json({ error: "ไม่พบผู้ใช้งาน" });
        
        const user = userResult.recordset[0];
        const userId = user.Id;
        const regDate = new Date(user.RegistrationDate);
        
        // 2. คำนวณวันหมดอายุ (30 วัน นับจากวันสมัคร)
        const expiryDate = new Date(regDate);
        expiryDate.setDate(expiryDate.getDate() + 30);
        
        const today = new Date();
        const diffTime = expiryDate - today;
        const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); // แปลงมิลลิวินาทีเป็นวัน
        
        let freeTicketsLeft = 0;
        let isEligibleForFree = daysLeft > 0; // ถ้ายังไม่เกิน 30 วัน ถือว่ามีสิทธิ์

        if (isEligibleForFree) {
            // 3. เช็คว่า "วันนี้" ใช้สิทธิ์เล่นฟรีไปกี่ครั้งแล้ว (ลิมิต 2 ครั้ง/วัน)
            const todayStr = today.toISOString().split('T')[0]; // ดึงแค่วันที่ เช่น 2026-07-03
            const usageResult = await pool.request()
                .input('uid', sql.Int, userId)
                .input('today', sql.Date, todayStr)
                .query(`
                    SELECT COUNT(*) as UsedToday 
                    FROM UserGameHistory 
                    WHERE UserId = @uid AND IsFreeTicket = 1 AND PlayDate = @today
                `);
            
            const usedToday = usageResult.recordset[0].UsedToday;
            freeTicketsLeft = Math.max(0, 2 - usedToday); // ให้สูงสุด 2 สิทธิ์ หักลบที่ใช้ไปแล้ว
        } else {
            isEligibleForFree = false; // เกิน 30 วันแล้ว หมดสิทธิ์เล่นฟรี
        }

        // 4. ดึงประวัติการเล่น (Statement) 5 รายการล่าสุดมาแสดง
        const historyResult = await pool.request()
            .input('uid', sql.Int, userId)
            .query(`
                SELECT TOP 5 GameType, IsFreeTicket, PlayDate, PlayTime, ResultStatus, RewardAmount 
                FROM UserGameHistory 
                WHERE UserId = @uid 
                ORDER BY PlayDate DESC, PlayTime DESC
            `);

        res.json({
            success: true,
            stats: {
                daysLeft: daysLeft > 0 ? daysLeft : 0, // จำนวนวันที่เหลือ
                isEligible: isEligibleForFree,         // อยู่ในโปร 30 วันหรือไม่
                freeTicketsToday: freeTicketsLeft,     // สิทธิ์ที่เหลือในวันนี้ (0, 1, หรือ 2)
                gameHistory: historyResult.recordset   // ประวัติการเล่น
            }
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 1. API ดึงข้อมูลหน้าเกม (เช็คยอดเงิน, ตั๋ว, สถานะปุ่มกดรับ)
// ==============================================================
app.get('/api/game/info', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        const settingsRes = await pool.request().query("SELECT * FROM GameSettings");

        const userRes = await pool.request()
            .input('user', sql.VarChar, username)
            .query(`SELECT u.Id, ISNULL(w.Balance, 0) as Balance FROM UsersRegister u LEFT JOIN Wallets w ON u.Id = w.UserId WHERE u.Username = @user`);

        if (userRes.recordset.length === 0) return res.status(404).json({ error: "ไม่พบผู้ใช้งาน" });
        const user = userRes.recordset[0];

        const bkkDate = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).split(',')[0];

        // เช็คตั๋วจาก UserGameTickets ที่อัปเดตแล้ว
        const ticketRes = await pool.request()
            .input('uid', sql.Int, user.Id)
            .query(`SELECT FreeTickets, LastDailyClaim FROM UserGameTickets WHERE UserId = @uid`);

        let freeTickets = 0;
        let canClaimToday = true;

        if (ticketRes.recordset.length > 0) {
            const ticketData = ticketRes.recordset[0];
            freeTickets = ticketData.FreeTickets;
            const lastClaim = ticketData.LastDailyClaim ? new Date(ticketData.LastDailyClaim).toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).split(',')[0] : '';
            if (lastClaim === bkkDate) {
                canClaimToday = false; // วันนี้เคยกดรับสิทธิ์ไปแล้ว
            }
        }

        res.json({ success: true, freeTickets, balance: user.Balance, canClaimToday, settings: settingsRes.recordset });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 2. API กดรับสิทธิ์ฟรีรายวัน (รับ 2 สิทธิ์ลง UserGameTickets)
// ==============================================================
app.post('/api/tickets/claim-daily', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: "ระบุผู้ใช้งาน" });

    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const userRes = await transaction.request()
                .input('user', sql.VarChar, username)
                .query(`SELECT Id FROM UsersRegister WHERE Username = @user`);
            if (userRes.recordset.length === 0) throw new Error("ไม่พบผู้ใช้งาน");
            const userId = userRes.recordset[0].Id;

            const bkkDate = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).split(',')[0];

            const ticketRes = await transaction.request()
                .input('uid', sql.Int, userId)
                .query(`SELECT LastDailyClaim FROM UserGameTickets WHERE UserId = @uid`);

            if (ticketRes.recordset.length > 0) {
                const lastClaim = ticketRes.recordset[0].LastDailyClaim ? new Date(ticketRes.recordset[0].LastDailyClaim).toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).split(',')[0] : '';
                if (lastClaim === bkkDate) {
                    throw new Error("คุณกดรับสิทธิ์ของวันนี้ไปแล้ว!");
                }
                // อัปเดตตั๋วเป็น 2 สิทธิ์ และเปลี่ยนวันที่รับเป็นวันนี้
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('today', sql.Date, bkkDate)
                    .query(`UPDATE UserGameTickets SET FreeTickets = 2, LastDailyClaim = @today, LastUpdated = GETDATE() WHERE UserId = @uid`);
            } else {
                // ถ้าไม่เคยมีฐานข้อมูลการเล่นมาก่อน ให้สร้างใหม่
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('today', sql.Date, bkkDate)
                    .query(`INSERT INTO UserGameTickets (UserId, FreeTickets, ReferralTickets, LastUpdated, LastDailyClaim) VALUES (@uid, 2, 0, GETDATE(), @today)`);
            }

            // บันทึก Log การรับสิทธิ์ ลงตารางที่เพิ่งสร้าง
            await transaction.request()
                .input('uid', sql.Int, userId)
                .input('today', sql.Date, bkkDate)
                .query(`INSERT INTO TicketClaimLogs (UserId, ClaimType, Amount, ClaimDate) VALUES (@uid, 'DAILY', 2, @today)`);

            await transaction.commit();
            res.json({ success: true, message: "🎁 กดรับสิทธิ์ฟรี 2 ครั้งสำเร็จ! รีบไปลุยสอยดาวกันเลย!" });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// ==============================================================
// 🌟 3. API ระบบกดเล่นเกมสอยดาว (เพิ่มการบันทึก Statement)
// ==============================================================
app.post('/api/game/play', async (req, res) => {
    const { username, gameType } = req.body;
    if (!username || !gameType) return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วน" });

    try {
        let pool = await sql.connect(config);
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const settingRes = await transaction.request()
                .input('type', sql.VarChar, gameType)
                .query("SELECT Cost, RewardAmount FROM GameSettings WHERE GameType = @type");

            if (settingRes.recordset.length === 0) throw new Error("ไม่พบการตั้งค่าเกมนี้ในระบบ");
            
            const cost = Number(settingRes.recordset[0].Cost); 
            const potentialReward = Number(settingRes.recordset[0].RewardAmount);

            const userRes = await transaction.request()
                .input('user', sql.VarChar, username)
                .query(`SELECT u.Id, ISNULL(w.Balance, 0) as Balance, w.Currency FROM UsersRegister u LEFT JOIN Wallets w ON u.Id = w.UserId WHERE u.Username = @user`);

            if (userRes.recordset.length === 0) throw new Error("ไม่พบผู้ใช้งาน");
            const userId = userRes.recordset[0].Id;
            const balance = Number(userRes.recordset[0].Balance);
            const userCurrency = userRes.recordset[0].Currency || 'THB'; // ดึงสกุลเงินของผู้ใช้

            let isFreeTicket = 0;
            const bkkDate = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Bangkok' }).split(',')[0];
            const bkkTime = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok' }).split(', ')[1];

            // 🌟 ตรวจสอบและหักจำนวนสิทธิ์
            if (cost === 0) {
                // ... (Logic การหักตั๋วฟรีของคุณเหมือนเดิม) ...
                const ticketRes = await transaction.request()
                    .input('uid', sql.Int, userId)
                    .query(`SELECT FreeTickets FROM UserGameTickets WHERE UserId = @uid`);

                if (ticketRes.recordset.length === 0 || ticketRes.recordset[0].FreeTickets <= 0) {
                    throw new Error("คุณไม่มีสิทธิ์ฟรี กรุณากดปุ่ม 'รับสิทธิ์ประจำวัน' ก่อนเล่น!");
                }

                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .query(`UPDATE UserGameTickets SET FreeTickets = FreeTickets - 1, LastUpdated = GETDATE() WHERE UserId = @uid`);

                isFreeTicket = 1;
            } else {
                if (balance < cost) throw new Error(`ยอดเงินไม่พอ (ต้องการ ${cost} ฿)`);
                
                // 1. หักเงินในกระเป๋า
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('cost', sql.Decimal(18,2), cost)
                    .query(`UPDATE Wallets SET Balance = Balance - @cost WHERE UserId = @uid`);
                
                // 🌟 2. บันทึก Statement ขาออก (ค่าเล่นเกม) ลงในตาราง Transactions
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('type', sql.VarChar, 'GAME_PLAY') // ระบุประเภทชัดเจนว่าเสียเงินค่าเล่น
                    .input('amt', sql.Decimal(18,2), cost)
                    .input('currency', sql.VarChar, userCurrency) // ส่งสกุลเงินไปด้วย
                    .query(`
                        INSERT INTO Transactions (UserId, TransactionType, Amount, Status, Currency, CreatedAt) 
                        VALUES (@uid, @type, @amt, 'COMPLETED', @currency, GETDATE())
                    `);
            }

            // สุ่มผลรางวัล 30%
            const isWin = Math.random() < 0.3;
            let finalReward = 0;
            let resultStatus = 'LOSE';

            if (isWin) {
                resultStatus = 'WIN';
                finalReward = potentialReward;
                
                // อัปเดตเงินรางวัลเข้ากระเป๋า
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('reward', sql.Decimal(18,2), finalReward)
                    .query(`UPDATE Wallets SET Balance = ISNULL(Balance,0) + @reward WHERE UserId = @uid`);

                // 🌟 บันทึก Statement ขาเข้า (ถูกรางวัล) ลงในตาราง Transactions
                await transaction.request()
                    .input('uid', sql.Int, userId)
                    .input('type', sql.VarChar, 'GAME_PRIZE') // เปลี่ยนชื่อเป็น GAME_PRIZE
                    .input('reward', sql.Decimal(18,2), finalReward)
                    .input('currency', sql.VarChar, userCurrency) // ส่งสกุลเงินไปด้วย
                    .input('ref', sql.VarChar, `WIN_${gameType}`) // ใส่ Ref id ว่าชนะจากเกมไหน
                    .query(`
                        INSERT INTO Transactions (UserId, TransactionType, Amount, Status, Currency, ReferenceId, CreatedAt) 
                        VALUES (@uid, @type, @reward, 'COMPLETED', @currency, @ref, GETDATE())
                    `);
            }

            // บันทึก Log การเล่นลง UserGameHistory (เหมือนเดิม)
            await transaction.request()
                .input('uid', sql.Int, userId)
                .input('gameType', sql.VarChar, gameType)
                .input('isFree', sql.Bit, isFreeTicket)
                .input('status', sql.VarChar, resultStatus)
                .input('reward', sql.Decimal(18,2), finalReward)
                .input('pDate', sql.Date, bkkDate)
                .input('pTime', sql.VarChar, bkkTime)
                .query(`INSERT INTO UserGameHistory (UserId, GameType, IsFreeTicket, ResultStatus, RewardAmount, PlayDate, PlayTime) VALUES (@uid, @gameType, @isFree, @status, @reward, @pDate, @pTime)`);

            await transaction.commit();
            res.json({ success: true, message: isWin ? `คุณได้รับรางวัล ${finalReward} บาท` : "เสียใจด้วย คุณไม่ถูกรางวัล", isWin, rewardAmount: finalReward });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// ==============================================================
// 🌟 API: สร้างคำขอฝากเงิน (ห้ามทำรายการซ้อน)
// ==============================================================
app.post('/api/p2p/create-order', async (req, res) => {
    const { username, amount, orderType } = req.body; 

    try {
        let pool = await sql.connect(config);
        
        // 1. หา RequesterId และ สกุลเงิน (Currency) ของผู้ใช้งาน
        // 🌟 อัปเดต: JOIN กับ UserBankAccounts เพื่อดึง Currency มาด้วย
        const userRes = await pool.request()
            .input('username', sql.VarChar, username)
            .query(`
                SELECT u.Id, b.Currency 
                FROM UsersRegister u
                LEFT JOIN UserBankAccounts b ON u.Username = b.Username AND (b.Status = 'Active' OR b.Status = 'APPROVED')
                WHERE u.Username = @username
            `);
            
        if (userRes.recordset.length === 0) return res.status(404).json({ success: false, message: "ไม่พบผู้ใช้งาน" });
        const requesterId = userRes.recordset[0].Id;
        // 🌟 หากไม่มีบัญชีธนาคาร (หรือไม่มีข้อมูลสกุลเงิน) ให้ใช้ 'THB' เป็นค่าเริ่มต้น
        const userCurrency = userRes.recordset[0].Currency || 'THB'; 

        // 🌟 2. เช็กว่ามีคำขอที่ยัง PENDING อยู่หรือไม่ (ป้องกันสแปม)
        // (คงระยะเวลา 60 นาทีไว้ตามโค้ดเดิมของคุณ)
        const pendingCheckRes = await pool.request()
            .input('uid', sql.Int, requesterId)
            .query(`
                SELECT COUNT(*) as PendingCount 
                FROM P2P_Orders 
                WHERE RequesterId = @uid 
                AND Status = 'PENDING' 
                AND DATEDIFF(MINUTE, CreatedAt, GETDATE()) <= 10
            `);
            
        if (pendingCheckRes.recordset[0].PendingCount > 0) {
             return res.status(400).json({ success: false, message: "คุณมีคำขอฝากเงินที่กำลังรอดำเนินการอยู่ กรุณารอสักครู่ก่อนทำรายการใหม่" });
        }

        // 3. ดึงค่าธรรมเนียม
        const feeRes = await pool.request()
            .input('amount', sql.Decimal, amount)
            .query(`SELECT FeePercentage FROM P2P_FeeTiers WHERE @amount >= MinAmount AND @amount <= MaxAmount`);
            
        if (feeRes.recordset.length === 0) return res.status(400).json({ success: false, message: "ไม่พบข้อมูลเรทค่าธรรมเนียม" });

        const feePercent = feeRes.recordset[0].FeePercentage;
        const feeAmount = (amount * feePercent) / 100;

        // 4. บันทึกคำขอ
        // 🌟 อัปเดต: เพิ่มการบันทึก Currency ลงใน P2P_Orders ด้วย
        await pool.request()
            .input('type', sql.VarChar, orderType)
            .input('uid', sql.Int, requesterId)
            .input('amt', sql.Decimal, amount)
            .input('fee', sql.Decimal, feeAmount)
            .input('currency', sql.VarChar, userCurrency) // 🌟 เพิ่มพารามิเตอร์นี้
            .query(`
                INSERT INTO P2P_Orders (OrderType, RequesterId, Amount, FeeAmount, Status, Currency)
                VALUES (@type, @uid, @amt, @fee, 'PENDING', @currency)
            `);

        res.json({ success: true, message: "สร้างคำขอสำเร็จ", feeCharged: feeAmount });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/p2p/orders/pending', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        
        // โค้ดดั้งเดิมของคุณแบบเพียวๆ (ไม่กรองประเทศ ไม่ตัดเวลา)
        let queryStr = `
            SELECT 
                o.Id, 
                o.OrderType, 
                o.Amount, 
                o.FeeAmount, 
                o.CreatedAt,
                u.Username
            FROM P2P_Orders o
            JOIN UsersRegister u ON o.RequesterId = u.Id
            WHERE o.Status = 'PENDING'
            ORDER BY o.CreatedAt DESC
        `;

        const result = await pool.request().query(queryStr);
        res.json({ success: true, orders: result.recordset });

    } catch (err) {
        // ส่ง Error ออกมาให้เห็นใน Network -> Response
        res.status(500).json({ success: false, error: err.message });
    }
});

/// ==============================================================
// 🌟 API: ดึงประวัติรายการ P2P (แก้ปัญหา Error 500)
// ==============================================================
app.get('/api/p2p/my-orders/:username', async (req, res) => {
    const { username } = req.params;
    try {
        let pool = await sql.connect(config);
        const request = pool.request();
        
        request.input('user', sql.NVarChar, username);

        // 🚨 จุดสำคัญ: ถ้าคอลัมน์ใน Database ของคุณไม่ได้ชื่อ MatchedUsername 
        // ให้แก้คำว่า MatchedUsername ด้านล่างนี้ ให้ตรงกับใน Database ของคุณเป๊ะๆ นะครับ
        // (เช่น อาจจะเป็น MatcherUsername, MatcherId, ReceiverUsername ฯลฯ)
        const queryStr = `
            SELECT * FROM P2P_Orders 
            WHERE Username = @user OR MatchedUsername = @user 
            ORDER BY CreatedAt DESC
        `;
        
        const result = await request.query(queryStr);
        res.json({ success: true, orders: result.recordset });

    } catch (err) {
        // ถ้าพัง มันจะส่ง Error Message กลับไปให้หน้าบ้านเห็น
        console.error("🔥 Error fetching my orders:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ==============================================================
// 🌟 API: ดึงข้อมูลบัญชีธนาคารของผู้ใช้ (สำหรับหน้า P2P TopUp)
// ==============================================================
app.get('/api/user/bank-account/:username', async (req, res) => {
    try {
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('username', sql.VarChar, req.params.username)
            .query(`
                SELECT TOP 1 BankName, AccountNumber 
                FROM UserBankAccounts 
                WHERE Username = @username AND Status = 'APPROVED' 
                ORDER BY CreatedAt DESC
            `);
            
        if (result.recordset.length > 0) {
            res.json({ success: true, bank: result.recordset[0] });
        } else {
            res.json({ success: false, message: 'ยังไม่มีบัญชีที่อนุมัติแล้ว' });
        }
    } catch (err) {
        console.error("Fetch Bank Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==============================================================
// 🌟 API: กดรับงาน P2P (หักเงิน Escrow + สร้างรหัสยืนยัน)
// ==============================================================
app.post('/api/p2p/match-order', async (req, res) => {
    const { orderId, matchedUsername } = req.body;

    try {
        let pool = await sql.connect(config);
        
        // หา UserId ของคนที่กดรับงานก่อน
        const userRes = await pool.request()
            .input('user', sql.VarChar, matchedUsername)
            .query(`SELECT Id FROM UsersRegister WHERE Username = @user`);
            
        if (userRes.recordset.length === 0) return res.status(404).json({ error: "ไม่พบผู้ใช้งานรับงาน" });
        const matchedUserId = userRes.recordset[0].Id;

        // 🌟 เริ่ม Transaction (ป้องกันคนกดพร้อมกัน แย่งงานกัน)
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // 1. เช็กสถานะงาน (ใช้ UPDLOCK ล็อกแถวนี้ไว้ชั่วคราว ป้องกันการแย่งข้อมูล)
            // 🌟 แก้ไข: เพิ่มการคำนวณ DiffMinutes จากฝั่ง SQL โดยตรง เพื่อเลี่ยงปัญหา Timezone
            const orderCheck = await transaction.request()
                .input('oId', sql.Int, orderId)
                .query(`
                    SELECT Amount, Status, RequesterId, CreatedAt, 
                    DATEDIFF(MINUTE, CreatedAt, GETDATE()) AS DiffMinutes 
                    FROM P2P_Orders WITH (UPDLOCK) 
                    WHERE Id = @oId
                `);
                
            if (orderCheck.recordset.length === 0) throw new Error("ไม่พบรายการนี้");
            const orderData = orderCheck.recordset[0];
            
            // 🌟 ตรวจสอบว่าเกิน 5 นาทีหรือยัง (ใช้ค่าเวลาจาก Database ล้วนๆ)
            if (orderData.DiffMinutes > 5) {
                 await transaction.request()
                    .input('oId', sql.Int, orderId)
                    .query(`UPDATE P2P_Orders SET Status = 'EXPIRED' WHERE Id = @oId`);
                 throw new Error("คำขอนี้หมดอายุแล้ว (เกิน 5 นาที)");
            }
                
            if (orderData.Status !== 'PENDING') {
                throw new Error("งานนี้มีผู้ใช้งานอื่นรับไปแล้ว ยังมีงานอื่นรอคุณ ขอบคุณที่ใช้บริการ");
            }

            if (orderData.RequesterId === matchedUserId) {
                throw new Error("คุณไม่สามารถรับงานของตัวเองได้");
            }

            // 2. เช็กยอดเงินในกระเป๋าของคนที่กดรับงาน
            const walletCheck = await transaction.request()
                .input('uid', sql.Int, matchedUserId)
                .query(`SELECT Balance FROM Wallets WHERE UserId = @uid`);
                
            const balance = walletCheck.recordset.length > 0 ? walletCheck.recordset[0].Balance : 0;
            if (balance < orderData.Amount) {
                throw new Error("ยอดเงินในกระเป๋าของคุณไม่เพียงพอสำหรับการรับงานนี้");
            }

            // 3. 💸 หักเงินเข้าสู่ระบบ Escrow (ลบเงินจากกระเป๋าคนรับงาน)
            await transaction.request()
                .input('uid', sql.Int, matchedUserId)
                .input('amt', sql.Decimal(18,4), orderData.Amount)
                .query(`UPDATE Wallets SET Balance = Balance - @amt WHERE UserId = @uid`);

            // 4. 🔑 สร้างรหัสยืนยัน 6 หลักสุ่ม (เช่น X7B9Q2)
            const confirmationCode = Math.random().toString(36).substring(2, 8).toUpperCase();

            // 5. อัปเดตสถานะงานเป็น MATCHED
            await transaction.request()
                .input('oId', sql.Int, orderId)
                .input('mId', sql.Int, matchedUserId)
                .input('code', sql.VarChar, confirmationCode)
                .query(`
                    UPDATE P2P_Orders 
                    SET Status = 'MATCHED', MatchedUserId = @mId, ConfirmationCode = @code, MatchedAt = GETDATE()
                    WHERE Id = @oId
                `);

            // (ถ้ามีระบบ Notification สามารถแทรกคำสั่ง INSERT แจ้งเตือนผู้ฝากเงินได้ที่นี่)

            await transaction.commit();
            res.json({ success: true, message: "รับงานสำเร็จ! กรุณารอผู้ฝากโอนเงิน", confirmationCode: confirmationCode });

        } catch (err) {
            await transaction.rollback();
            throw err; // ส่ง error ออกไปให้ catch ตัวนอก
        }

    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
});

// ==============================================================
// 🌟 API P2P (Step 3): ผู้ฝากเงินอัปโหลดสลิป
// ==============================================================
app.post('/api/p2p/upload-slip', async (req, res) => {
    const { orderId, slipImageBase64 } = req.body;

    try {
        let pool = await sql.connect(config);
        
        // อัปเดตสถานะเป็น SLIP_UPLOADED และเซฟรูป
        await pool.request()
            .input('oId', sql.Int, orderId)
            .input('slip', sql.NVarChar(sql.MAX), slipImageBase64)
            .query(`
                UPDATE P2P_Orders 
                SET Status = 'SLIP_UPLOADED', SlipUrl = @slip 
                WHERE Id = @oId AND Status = 'MATCHED'
            `);

        res.json({ success: true, message: "อัปโหลดสลิปสำเร็จ รอผู้รับงานตรวจสอบ" });
    } catch (err) {
        console.error("🔥 P2P Upload Slip Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
 

// ==============================================================
// 🌟 API P2P (Step 4): ผู้รับงานยืนยันได้รับยอดเงิน (จบงาน + จ่าย Affiliate 5%)
// ==============================================================
// ==============================================================
// 🌟 API P2P: ผู้รับงานยืนยันได้รับเงิน (กระจายเงิน + จ่าย 5% + สร้างประวัติ)
// ==============================================================
// ==============================================================
// 🌟 API P2P: ผู้รับงานยืนยันได้รับเงิน (กระจายเงิน + จ่าย 5% + สร้างประวัติ)
// ==============================================================
app.post('/api/p2p/confirm-receipt', async (req, res) => {
    const { orderId } = req.body;
    let pool = await sql.connect(config);
    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin();
        const request = new sql.Request(transaction);
        
        // 1. ดึงข้อมูลออเดอร์
        const orderRes = await request
            .input('id', sql.Int, orderId)
            .query(`SELECT * FROM P2P_Orders WHERE Id = @id AND Status = 'SLIP_UPLOADED'`);
            
        if (orderRes.recordset.length === 0) {
            throw new Error("ไม่พบรายการ หรือสถานะไม่ถูกต้อง (อาจมีการอนุมัติไปแล้ว)");
        }
        
        const order = orderRes.recordset[0];
        const requesterUsername = order.Username; // ผู้ต้องการเติมเงิน
        const matcherUsername = order.MatchedUsername; // ผู้รับงาน
        const amount = order.Amount; // ยอดเติม
        const feeAmount = order.FeeAmount; // ค่าธรรมเนียมผู้รับงาน
        const refCode = `P2P-${orderId}`; // รหัสอ้างอิง Transaction

        // 2. โอนเงินที่กักไว้ (Escrow) เข้ากระเป๋าผู้ฝากเงิน (Requester)
        await request
            .input('reqUser', sql.NVarChar, requesterUsername)
            .input('amount', sql.Decimal(18, 2), amount)
            .query(`UPDATE UsersRegister SET WalletBalance = ISNULL(WalletBalance, 0) + @amount WHERE Username = @reqUser`);

        // 3. จ่ายค่าธรรมเนียมให้ผู้รับงาน (Matcher) เข้ากระเป๋า
        await request
            .input('matchUser', sql.NVarChar, matcherUsername)
            .input('fee', sql.Decimal(18, 2), feeAmount)
            .query(`UPDATE UsersRegister SET WalletBalance = ISNULL(WalletBalance, 0) + @fee WHERE Username = @matchUser`);

        // 4. บันทึก Transaction ฝั่งผู้ฝาก (รับเงินเข้า) 🌟 ตัวใหม่ใช้ _DEP
        await request
            .input('reqDesc', sql.NVarChar, `เติมเงินผ่าน P2P สำเร็จ (รหัสรับงาน: ${matcherUsername})`)
            .query(`
                INSERT INTO Transactions (Username, Type, Amount, Status, Description, ReferenceCode, CreatedAt) 
                VALUES (@reqUser, 'DEPOSIT', @amount, 'COMPLETED', @reqDesc, '${refCode}_DEP', GETDATE())
            `);

        // 5. บันทึก Transaction ฝั่งผู้รับงาน (รับค่าธรรมเนียม) 🌟 ตัวใหม่ใช้ _FEE
        await request
            .input('matchDesc', sql.NVarChar, `รายได้ค่าธรรมเนียมรับงาน P2P (รหัสคำขอ: ${orderId})`)
            .query(`
                INSERT INTO Transactions (Username, Type, Amount, Status, Description, ReferenceCode, CreatedAt) 
                VALUES (@matchUser, 'P2P_FEE', @fee, 'COMPLETED', @matchDesc, '${refCode}_FEE', GETDATE())
            `);

        // ==========================================================
        // 🌟 6. ระบบคำนวณและจ่าย Affiliate 5% ให้ผู้แนะนำของผู้รับงาน
        // ==========================================================
        const affiliateFee = feeAmount * 0.05;

        const referrerRes = await request
            .query(`SELECT ReferrerUsername FROM UsersRegister WHERE Username = @matchUser`);
            
        if (referrerRes.recordset.length > 0 && referrerRes.recordset[0].ReferrerUsername) {
            const referrerUsername = referrerRes.recordset[0].ReferrerUsername;

            await request
                .input('affUser', sql.NVarChar, referrerUsername)
                .input('affFee', sql.Decimal(18, 2), affiliateFee)
                .query(`UPDATE UsersRegister SET WalletBalance = ISNULL(WalletBalance, 0) + @affFee WHERE Username = @affUser`);

            // 🌟 ตัวใหม่ใช้ _AFF
            await request
                .input('affDesc', sql.NVarChar, `ค่านายหน้า 5% จากทีมงาน (P2P Fee จาก ${matcherUsername})`)
                .query(`
                    INSERT INTO Transactions (Username, Type, Amount, Status, Description, ReferenceCode, CreatedAt) 
                    VALUES (@affUser, 'AFFILIATE_COMMISSION', @affFee, 'COMPLETED', @affDesc, '${refCode}_AFF', GETDATE())
                `);
        }

        // =========================================================
        // 🔔 ระบบแจ้งเตือน (Notifications) ให้ผู้เกี่ยวข้องทั้ง 3 ฝ่าย
        // =========================================================
        
        // 1. แจ้งเตือนผู้ฝากเงิน (Requester) ว่าเงินเข้าแล้ว
        await request
            .input('reqNotifUser', sql.NVarChar, requesterUsername)
            .input('reqNotifTitle', sql.NVarChar, 'รายการ P2P สำเร็จ 🎉')
            .input('reqNotifMsg', sql.NVarChar, `คำขอเติมเงินจำนวน ${amount} สำเร็จแล้ว! ยอดเงินเข้ากระเป๋าของคุณเรียบร้อย`)
            .query(`
                INSERT INTO Notifications (Username, Title, Message, IsRead, CreatedAt) 
                VALUES (@reqNotifUser, @reqNotifTitle, @reqNotifMsg, 0, GETDATE())
            `);

        // 2. แจ้งเตือนผู้รับงาน (Matcher) ว่าได้ค่าธรรมเนียมแล้ว
        await request
            .input('matchNotifUser', sql.NVarChar, matcherUsername)
            .input('matchNotifTitle', sql.NVarChar, 'รับค่าธรรมเนียม P2P 💰')
            .input('matchNotifMsg', sql.NVarChar, `คุณได้รับค่าธรรมเนียม ${feeAmount} จากการรับงาน P2P สำเร็จ`)
            .query(`
                INSERT INTO Notifications (Username, Title, Message, IsRead, CreatedAt) 
                VALUES (@matchNotifUser, @matchNotifTitle, @matchNotifMsg, 0, GETDATE())
            `);

        // 3. แจ้งเตือนผู้แนะนำ (Affiliate) ถ้ามี
        if (referrerRes.recordset.length > 0 && referrerRes.recordset[0].ReferrerUsername) {
            await request
                .input('affNotifUser', sql.NVarChar, referrerUsername)
                .input('affNotifTitle', sql.NVarChar, 'ได้รับค่านายหน้า 5% 🎁')
                .input('affNotifMsg', sql.NVarChar, `คุณได้รับค่านายหน้า ${affiliateFee} จากทีมงาน (${matcherUsername}) ที่ทำรายการ P2P สำเร็จ`)
                .query(`
                    INSERT INTO Notifications (Username, Title, Message, IsRead, CreatedAt) 
                    VALUES (@affNotifUser, @affNotifTitle, @affNotifMsg, 0, GETDATE())
                `);
        }

        await transaction.commit();
        res.json({ success: true, message: "กระทบยอดและกระจายรายได้สำเร็จเรียบร้อย" });

    } catch (err) {
        await transaction.rollback();
        console.error("🔥 Error in P2P Confirm Receipt:", err.message);
        res.status(500).json({ success: false, error: "เกิดข้อผิดพลาดในการกระจายเงิน: " + err.message });
    }
});

// ==============================================================
// 🌟 API P2P: ดึงรายละเอียด Order 1 รายการ (สำหรับหน้า P2POrderDetail)
// ==============================================================
app.get('/api/p2p/order/:id', async (req, res) => {
    const { id } = req.params;
    try {
        let pool = await sql.connect(config);
        const orderRes = await pool.request()
            .input('id', sql.Int, id)
            .query(`
                SELECT 
                    o.*, 
                    reqU.Username AS RequesterUsername, 
                    matchU.Username AS MatchedUsername,
                    b.BankName, b.AccountNumber, b.AccountName, b.BankLogo
                FROM P2P_Orders o
                LEFT JOIN UsersRegister reqU ON o.RequesterId = reqU.Id
                LEFT JOIN UsersRegister matchU ON o.MatchedUserId = matchU.Id
                LEFT JOIN UserBankAccounts b ON matchU.Username = b.Username AND (b.Status = 'Active' OR b.Status = 'APPROVED')
                WHERE o.Id = @id
            `);
            
        if (orderRes.recordset.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบรายการ" });
        }
        
        res.json({ success: true, order: orderRes.recordset[0] });
    } catch (err) {
        console.error("🔥 Fetch Order Detail Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});
// ✅ โค้ดที่ถูกต้อง (สังเกตวงเล็บหน้า Username และหลัง @username)
app.get('/api/p2p/my-orders/:username', async (req, res) => {
    const { username } = req.params;
    try {
        let pool = await sql.connect(config);
        const orders = await pool.request()
            .input('username', sql.NVarChar, username)
            .query(`
                SELECT * FROM P2P_Orders 
                WHERE (Username = @username OR MatchedUsername = @username) 
                AND Status IN ('PENDING', 'MATCHED', 'SLIP_UPLOADED', 'COMPLETED')
                ORDER BY CreatedAt DESC
            `);
        res.json({ success: true, orders: orders.recordset });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==============================================================
// 🌟 API: ดึงยอดเงินล่าสุดของผู้ใช้งาน (Wallet Balance)
// ==============================================================
app.get('/api/user/balance/:username', async (req, res) => {
    const { username } = req.params;
    try {
        let pool = await sql.connect(config);
        const result = await pool.request()
            .input('username', sql.NVarChar, username)
            .query(`SELECT WalletBalance FROM UsersRegister WHERE Username = @username`);
            
        if (result.recordset.length > 0) {
            // ดึงยอดเงินมา ถ้าเป็น null ให้ตีเป็น 0
            const balance = result.recordset[0].WalletBalance || 0; 
            res.json({ success: true, balance: balance });
        } else {
            res.status(404).json({ success: false, error: "ไม่พบผู้ใช้งาน" });
        }
    } catch (err) {
        console.error("🔥 Error fetching balance:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ให้ระบบใช้ Port ของ Railway ถ้ามี แต่ถ้ารันในคอมเราให้ใช้ 5100
const PORT = process.env.PORT || 5100;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});