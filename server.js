const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000 });
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret';
const publicDir = path.join(__dirname, 'public');
const uploadDir = process.env.UPLOAD_DIR || path.join(process.env.DATA_DIR || path.join(__dirname,'data'),'uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const allowedMime=new Set(['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain']);
const upload=multer({storage:multer.diskStorage({destination:uploadDir,filename:(_req,file,done)=>{const ext=path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g,'').slice(0,8);done(null,`${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)}}),limits:{fileSize:8*1024*1024},fileFilter:(_req,file,done)=>done(allowedMime.has(file.mimetype)?null:new Error('Недоступный тип файла'),allowedMime.has(file.mimetype))});
const smtp = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;
const codeHash = (email, code) => crypto.createHash('sha256').update(`${email}:${code}:${JWT_SECRET}`).digest('hex');
const inviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();

async function deliverCode(email, code) {
  if (!smtp) return false;
  await smtp.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Код подтверждения Pulse',
    text: `Код подтверждения: ${code}. Он действует 10 минут.`,
    html: `<div style="font-family:Arial;padding:24px;background:#0d1018;color:#fff"><h2>Pulse</h2><p>Код подтверждения:</p><div style="font-size:32px;letter-spacing:8px;font-weight:800">${code}</div><p style="color:#9ca3af">Код действует 10 минут.</p></div>`
  });
  return true;
}

function findOrCreateSocialUser(provider, providerId, email, displayName) {
  const column = provider === 'google' ? 'google_id' : 'github_id';
  email = String(email || `${providerId}@users.noreply.${provider}.com`).toLowerCase();
  let user = db.prepare(`SELECT * FROM users WHERE ${column}=? OR email=? COLLATE NOCASE`).get(String(providerId), email);
  if (user) {
    db.prepare(`UPDATE users SET ${column}=? WHERE id=?`).run(String(providerId), user.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  }
  const baseName = clean(displayName || `${provider} user`, 24) || `${provider} user`;
  let username = baseName, n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) username = `${baseName.slice(0,20)}${++n}`;
  const hash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10), colors = ['#8b5cf6','#06b6d4','#ec4899','#22c55e','#f59e0b'];
  const out = db.prepare(`INSERT INTO users(username,email,password_hash,accent,${column}) VALUES(?,?,?,?,?)`).run(username,email,hash,colors[Math.abs(Number(providerId)||0)%colors.length],String(providerId));
  user = db.prepare('SELECT * FROM users WHERE id=?').get(out.lastInsertRowid);
  let welcome = db.prepare('SELECT id FROM spaces ORDER BY id LIMIT 1').get();
  if (!welcome) {
    const s = db.prepare("INSERT INTO spaces(name,description,icon,owner_id,invite_code) VALUES('Орбита','Общее пространство для первых разговоров','◉',?,?)").run(user.id,inviteCode());
    welcome = {id:Number(s.lastInsertRowid)};
    db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?,'общий','Знакомства, идеи и живые разговоры')").run(welcome.id);
    db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?,'проекты','Делимся тем, над чем работаем')").run(welcome.id);
  }
  db.prepare("INSERT OR IGNORE INTO space_members(space_id,user_id,role) VALUES(?,?,?)").run(welcome.id,user.id,user.id===1?'owner':'member');
  return user;
}

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use('/uploads',express.static(uploadDir,{maxAge:'7d',immutable:true}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-7' }));

const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const userView = (u) => u && ({ id: u.id, username: u.username, status: u.status_text, accent: u.accent, createdAt: u.created_at });
const tokenFor = (user) => jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
  }
}

function channelAccess(channelId, userId) {
  return db.prepare(`SELECT c.*, s.name space_name FROM channels c
    JOIN spaces s ON s.id=c.space_id JOIN space_members sm ON sm.space_id=s.id
    WHERE c.id=? AND sm.user_id=?`).get(channelId, userId);
}

function messageView(row) {
  return row && { id: row.id, content: row.content, edited: !!row.edited, replyTo: row.reply_to_id || null, attachment:row.attachment_url?{url:row.attachment_url,name:row.attachment_name,type:row.attachment_type}:null, createdAt: row.created_at,
    user: { id: row.user_id, username: row.username, accent: row.accent, status: row.status_text } };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Pulse', version:'1.6.0', updated:'2026-10-09' }));
app.post('/api/upload',auth,(req,res)=>upload.single('file')(req,res,err=>{if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Файл больше 8 МБ':err.message||'Не удалось загрузить файл'});if(!req.file)return res.status(400).json({error:'Файл не выбран.'});res.status(201).json({url:`/uploads/${req.file.filename}`,name:clean(req.file.originalname,120),type:req.file.mimetype,size:req.file.size})}));
app.get('/api/config',(_req,res)=>{const iceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];if(process.env.TURN_URL)iceServers.push({urls:process.env.TURN_URL,username:process.env.TURN_USERNAME||'',credential:process.env.TURN_CREDENTIAL||''});res.json({iceServers,voice:true,githubAuth:!!(process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET),googleAuth:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET)})});

app.get('/api/auth/github',(req,res)=>{
  if(!process.env.GITHUB_CLIENT_ID||!process.env.GITHUB_CLIENT_SECRET)return res.redirect('/#oauth_error=GitHub вход не настроен');
  const base=process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`,redirectUri=`${base}/api/auth/github/callback`,state=jwt.sign({purpose:'github',base},JWT_SECRET,{expiresIn:'10m'});
  const url=new URL('https://github.com/login/oauth/authorize');url.searchParams.set('client_id',process.env.GITHUB_CLIENT_ID);url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('scope','read:user user:email');url.searchParams.set('state',state);res.redirect(url.toString());
});
app.get('/api/auth/github/callback',async(req,res)=>{
  let payload;try{payload=jwt.verify(String(req.query.state||''),JWT_SECRET);if(payload.purpose!=='github')throw new Error('state')}catch{return res.redirect('/#oauth_error=Сессия GitHub истекла')}
  const base=process.env.PUBLIC_URL||payload.base||`${req.protocol}://${req.get('host')}`;
  if(req.query.error)return res.redirect(`/#oauth_error=${encodeURIComponent('GitHub отменил авторизацию')}`);
  try{
    const tokenRes=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code:req.query.code,redirect_uri:`${base}/api/auth/github/callback`})});const tokenData=await tokenRes.json();if(!tokenData.access_token)throw new Error('GitHub не выдал токен');
    const headers={Authorization:`Bearer ${tokenData.access_token}`,Accept:'application/vnd.github+json','User-Agent':'Pulse-Chat'};const profile=await (await fetch('https://api.github.com/user',{headers})).json();if(!profile.id)throw new Error('Профиль GitHub недоступен');
    let email=profile.email;if(!email){const emails=await (await fetch('https://api.github.com/user/emails',{headers})).json();email=Array.isArray(emails)?(emails.find(x=>x.primary&&x.verified)||emails.find(x=>x.verified))?.email:null}email=(email||`${profile.id}@users.noreply.github.com`).toLowerCase();
    let user=db.prepare('SELECT * FROM users WHERE github_id=? OR email=? COLLATE NOCASE').get(String(profile.id),email);
    if(user){db.prepare('UPDATE users SET github_id=? WHERE id=?').run(String(profile.id),user.id);user=db.prepare('SELECT * FROM users WHERE id=?').get(user.id)}else{
      const baseName=clean(profile.name||profile.login||'GitHub User',24)||'GitHub User';let username=baseName,n=1;while(db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username))username=`${baseName.slice(0,20)}${++n}`;
      const hash=bcrypt.hashSync(crypto.randomBytes(32).toString('hex'),10),colors=['#8b5cf6','#06b6d4','#ec4899','#22c55e','#f59e0b'];const out=db.prepare('INSERT INTO users(username,email,password_hash,accent,github_id) VALUES(?,?,?,?,?)').run(username,email,hash,colors[profile.id%colors.length],String(profile.id));user=db.prepare('SELECT * FROM users WHERE id=?').get(out.lastInsertRowid);
      let welcome=db.prepare('SELECT id FROM spaces ORDER BY id LIMIT 1').get();if(!welcome){const s=db.prepare("INSERT INTO spaces(name,description,icon,owner_id,invite_code) VALUES('Орбита','Общее пространство для первых разговоров','◉',?,?)").run(user.id,inviteCode());welcome={id:Number(s.lastInsertRowid)};db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?,'общий','Знакомства, идеи и живые разговоры')").run(welcome.id);db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?,'проекты','Делимся тем, над чем работаем')").run(welcome.id)}db.prepare("INSERT OR IGNORE INTO space_members(space_id,user_id,role) VALUES(?,?,?)").run(welcome.id,user.id,user.id===1?'owner':'member');
    }
    const appToken=tokenFor(user);res.redirect(`/#oauth_token=${encodeURIComponent(appToken)}`)
  }catch(e){console.error('GitHub OAuth:',e);res.redirect(`/#oauth_error=${encodeURIComponent('Не удалось войти через GitHub')}`)}
});

app.get('/api/auth/google',(req,res)=>{
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.redirect('/#oauth_error=Google вход не настроен');
  const base=process.env.PUBLIC_URL||`${req.protocol}://${req.get('host')}`,redirectUri=`${base}/api/auth/google/callback`,state=jwt.sign({purpose:'google',base},JWT_SECRET,{expiresIn:'10m'});
  const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');url.searchParams.set('client_id',process.env.GOOGLE_CLIENT_ID);url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('response_type','code');url.searchParams.set('scope','openid email profile');url.searchParams.set('state',state);url.searchParams.set('prompt','select_account');res.redirect(url.toString());
});
app.get('/api/auth/google/callback',async(req,res)=>{
  let payload;try{payload=jwt.verify(String(req.query.state||''),JWT_SECRET);if(payload.purpose!=='google')throw new Error('state')}catch{return res.redirect('/#oauth_error=Сессия Google истекла')}
  const base=process.env.PUBLIC_URL||payload.base||`${req.protocol}://${req.get('host')}`;
  if(req.query.error)return res.redirect(`/#oauth_error=${encodeURIComponent('Google отменил авторизацию')}`);
  try{
    const body=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,code:String(req.query.code||''),grant_type:'authorization_code',redirect_uri:`${base}/api/auth/google/callback`});
    const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const tokenData=await tokenRes.json();if(!tokenData.access_token)throw new Error('Google не выдал токен');
    const profile=await (await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${tokenData.access_token}`}})).json();if(!profile.sub||!profile.email)throw new Error('Профиль Google недоступен');
    const user=findOrCreateSocialUser('google',profile.sub,profile.email,profile.name||profile.email.split('@')[0]);res.redirect(`/#oauth_token=${encodeURIComponent(tokenFor(user))}`)
  }catch(e){console.error('Google OAuth:',e);res.redirect(`/#oauth_error=${encodeURIComponent('Не удалось войти через Google')}`)}
});

app.post('/api/auth/register', async (req, res) => {
  const username = clean(req.body.username, 24).replace(/\s+/g, ' ');
  const email = clean(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  if (username.length < 2) return res.status(400).json({ error: 'Имя должно содержать минимум 2 символа.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Укажите корректную почту.' });
  if (password.length < 8 || !/[a-zа-я]/i.test(password) || !/\d/.test(password)) return res.status(400).json({ error: 'Пароль: минимум 8 символов, буквы и цифры.' });
  if (db.prepare('SELECT 1 FROM users WHERE email=? OR username=?').get(email, username)) return res.status(409).json({ error: 'Имя или почта уже используются.' });
  try {
    const code = String(crypto.randomInt(100000, 1000000));
    const hash = await bcrypt.hash(password, 11);
    db.prepare(`INSERT INTO pending_registrations(email,username,password_hash,code_hash,expires_at,attempts)
      VALUES(?,?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,
      code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0`).run(email, username, hash, codeHash(email, code), Date.now() + 10 * 60 * 1000);
    const sent = await deliverCode(email, code);
    console.log(`Код Pulse для ${email}: ${code}`);
    res.json({ verificationRequired:true, email, sent, ...(!sent || process.env.NODE_ENV !== 'production' ? { devCode:code } : {}) });
  } catch (e) { console.error(e); res.status(500).json({ error:'Не удалось отправить код.' }); }
});

app.post('/api/auth/register/verify', (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase(); const code = clean(req.body.code, 6);
  const pending = db.prepare('SELECT * FROM pending_registrations WHERE email=?').get(email);
  if (!pending || pending.expires_at < Date.now()) return res.status(400).json({ error:'Код истёк. Запросите новый.' });
  if (pending.attempts >= 5) return res.status(429).json({ error:'Слишком много попыток. Запросите новый код.' });
  if (pending.code_hash !== codeHash(email, code)) {
    db.prepare('UPDATE pending_registrations SET attempts=attempts+1 WHERE email=?').run(email);
    return res.status(400).json({ error:'Неверный код подтверждения.' });
  }
  try {
    const accentColors=['#8b5cf6','#06b6d4','#ec4899','#22c55e','#f59e0b'];
    const make=db.transaction(()=>{
      const out=db.prepare('INSERT INTO users(username,email,password_hash,accent) VALUES(?,?,?,?)').run(pending.username,email,pending.password_hash,accentColors[Math.floor(Math.random()*accentColors.length)]);
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(out.lastInsertRowid); let welcome=db.prepare('SELECT id FROM spaces ORDER BY id LIMIT 1').get();
      if(!welcome){const space=db.prepare("INSERT INTO spaces(name,description,icon,owner_id,invite_code) VALUES('Орбита','Общее пространство для первых разговоров','◉',?,?)").run(user.id,inviteCode());welcome={id:Number(space.lastInsertRowid)};db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?, 'общий', 'Знакомства, идеи и живые разговоры')").run(welcome.id);db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?, 'проекты', 'Делимся тем, над чем работаем')").run(welcome.id)}
      db.prepare("INSERT OR IGNORE INTO space_members(space_id,user_id,role) VALUES(?,?,?)").run(welcome.id,user.id,welcome.id===1&&user.id===1?'owner':'member');db.prepare('DELETE FROM pending_registrations WHERE email=?').run(email);return user;
    });
    const user=make();res.status(201).json({token:tokenFor(user),user:userView(user)});
  } catch(e){if(String(e.message).includes('UNIQUE'))return res.status(409).json({error:'Имя или почта уже используются.'});console.error(e);res.status(500).json({error:'Не удалось завершить регистрацию.'})}
});

app.post('/api/auth/login', async (req, res) => {
  const login = clean(req.body.login, 120);
  const user = db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE').get(login, login);
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash)))
    return res.status(401).json({ error: 'Неверное имя, почта или пароль.' });
  res.json({ token: tokenFor(user), user: userView(user) });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден.' });
  res.json({ ...userView(user), email:user.email, emailVerified:true });
});

app.patch('/api/me', auth, (req, res) => {
  const status = clean(req.body.status, 60) || 'На связи';
  const accent = /^#[0-9a-f]{6}$/i.test(req.body.accent) ? req.body.accent : '#8b5cf6';
  db.prepare('UPDATE users SET status_text=?, accent=? WHERE id=?').run(status, accent, req.user.id);
  const updated=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);res.json({ ...userView(updated), email:updated.email, emailVerified:true });
});

app.get('/api/spaces', auth, (req, res) => {
  const spaces = db.prepare(`SELECT s.*, sm.role, (SELECT COUNT(*) FROM space_members WHERE space_id=s.id) member_count
    FROM spaces s JOIN space_members sm ON sm.space_id=s.id WHERE sm.user_id=? ORDER BY sm.joined_at`).all(req.user.id);
  res.json(spaces.map(s => ({ id:s.id, name:s.name, description:s.description, icon:s.icon, role:s.role, members:s.member_count })));
});

app.get('/api/spaces/discover', auth, (req, res) => {
  const spaces = db.prepare(`SELECT s.id,s.name,s.description,s.icon,COUNT(sm.user_id) member_count,
    EXISTS(SELECT 1 FROM space_members mine WHERE mine.space_id=s.id AND mine.user_id=?) joined
    FROM spaces s LEFT JOIN space_members sm ON sm.space_id=s.id WHERE s.is_public=1 GROUP BY s.id ORDER BY member_count DESC LIMIT 30`).all(req.user.id);
  res.json(spaces.map(s => ({ ...s, joined: !!s.joined })));
});

app.post('/api/spaces', auth, (req, res) => {
  const name = clean(req.body.name, 32); const description = clean(req.body.description, 140); const icon = clean(req.body.icon, 2) || '✦';
  if (name.length < 2) return res.status(400).json({ error: 'Название слишком короткое.' });
  const make = db.transaction(() => {
    const result = db.prepare('INSERT INTO spaces(name,description,icon,owner_id,invite_code) VALUES(?,?,?,?,?)').run(name, description, icon, req.user.id, inviteCode());
    db.prepare("INSERT INTO space_members(space_id,user_id,role) VALUES(?,?,'owner')").run(result.lastInsertRowid, req.user.id);
    db.prepare("INSERT INTO channels(space_id,name,topic) VALUES(?, 'общий', 'Главный канал пространства')").run(result.lastInsertRowid);
    return Number(result.lastInsertRowid);
  });
  const id = make(); res.status(201).json({ id, name, description, icon, role:'owner', members:1 });
});

app.post('/api/spaces/:id/join', auth, (req, res) => {
  const space = db.prepare('SELECT * FROM spaces WHERE id=? AND is_public=1').get(req.params.id);
  if (!space) return res.status(404).json({ error: 'Пространство не найдено.' });
  db.prepare('INSERT OR IGNORE INTO space_members(space_id,user_id) VALUES(?,?)').run(space.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/spaces/join-code', auth, (req,res)=>{
  const code=clean(req.body.code,16).toUpperCase();const space=db.prepare('SELECT * FROM spaces WHERE invite_code=?').get(code);
  if(!space)return res.status(404).json({error:'Код приглашения не найден.'});
  db.prepare('INSERT OR IGNORE INTO space_members(space_id,user_id) VALUES(?,?)').run(space.id,req.user.id);res.json({ok:true,spaceId:space.id});
});
app.get('/api/spaces/:id/invite', auth, (req,res)=>{
  const member=db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(req.params.id,req.user.id);
  if(!member)return res.status(403).json({error:'Нет доступа.'});let space=db.prepare('SELECT invite_code FROM spaces WHERE id=?').get(req.params.id);
  if(!space.invite_code){space.invite_code=inviteCode();db.prepare('UPDATE spaces SET invite_code=? WHERE id=?').run(space.invite_code,req.params.id)}res.json({code:space.invite_code});
});

app.get('/api/spaces/:id/channels', auth, (req, res) => {
  const member = db.prepare('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!member) return res.status(403).json({ error: 'Нет доступа.' });
  res.json(db.prepare('SELECT id,name,topic FROM channels WHERE space_id=? ORDER BY id').all(req.params.id));
});

app.get('/api/spaces/:id/voice-channels', auth, (req,res)=>{
  const member=db.prepare('SELECT 1 FROM space_members WHERE space_id=? AND user_id=?').get(req.params.id,req.user.id);if(!member)return res.status(403).json({error:'Нет доступа.'});
  let rows=db.prepare('SELECT id,name FROM voice_channels WHERE space_id=? ORDER BY id').all(req.params.id);if(!rows.length){db.prepare("INSERT INTO voice_channels(space_id,name) VALUES(?,'Лаунж')").run(req.params.id);rows=db.prepare('SELECT id,name FROM voice_channels WHERE space_id=? ORDER BY id').all(req.params.id)}res.json(rows);
});
app.post('/api/spaces/:id/voice-channels',auth,(req,res)=>{
  const m=db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(req.params.id,req.user.id);if(!m||!['owner','admin'].includes(m.role))return res.status(403).json({error:'Нет доступа.'});const name=clean(req.body.name,30);if(name.length<2)return res.status(400).json({error:'Название слишком короткое.'});try{const out=db.prepare('INSERT INTO voice_channels(space_id,name) VALUES(?,?)').run(req.params.id,name);res.status(201).json({id:Number(out.lastInsertRowid),name})}catch{res.status(409).json({error:'Такой голосовой канал уже есть.'})}
});

app.post('/api/spaces/:id/channels', auth, (req, res) => {
  const membership = db.prepare('SELECT role FROM space_members WHERE space_id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!membership || !['owner','admin'].includes(membership.role)) return res.status(403).json({ error: 'Создавать каналы могут администраторы.' });
  const name = clean(req.body.name, 30).toLowerCase().replace(/\s+/g, '-'); const topic = clean(req.body.topic, 120);
  if (name.length < 2) return res.status(400).json({ error: 'Название слишком короткое.' });
  try {
    const out = db.prepare('INSERT INTO channels(space_id,name,topic) VALUES(?,?,?)').run(req.params.id, name, topic);
    res.status(201).json({ id:Number(out.lastInsertRowid), name, topic });
  } catch { res.status(409).json({ error: 'Такой канал уже существует.' }); }
});

app.get('/api/channels/:id/messages', auth, (req, res) => {
  if (!channelAccess(req.params.id, req.user.id)) return res.status(403).json({ error: 'Нет доступа.' });
  const rows = db.prepare(`SELECT m.*,u.username,u.accent,u.status_text FROM
    (SELECT * FROM channel_messages WHERE channel_id=? ORDER BY id DESC LIMIT 80) m
    JOIN users u ON u.id=m.user_id ORDER BY m.id`).all(req.params.id);
  res.json(rows.map(messageView));
});

app.get('/api/users', auth, (req, res) => {
  const q = `%${clean(req.query.q, 40)}%`;
  const rows = db.prepare('SELECT * FROM users WHERE id<>? AND username LIKE ? ORDER BY username LIMIT 30').all(req.user.id, q);
  res.json(rows.map(userView));
});
app.post('/api/friends/:userId', auth, (req,res)=>{
  const other=Number(req.params.userId);if(other===req.user.id||!db.prepare('SELECT 1 FROM users WHERE id=?').get(other))return res.status(400).json({error:'Пользователь не найден.'});
  const reverse=db.prepare("SELECT status FROM friends WHERE requester_id=? AND addressee_id=?").get(other,req.user.id);
  if(reverse?.status==='pending'){db.prepare("UPDATE friends SET status='accepted' WHERE requester_id=? AND addressee_id=?").run(other,req.user.id);return res.json({status:'accepted'})}
  db.prepare("INSERT INTO friends(requester_id,addressee_id,status) VALUES(?,?,'pending') ON CONFLICT(requester_id,addressee_id) DO NOTHING").run(req.user.id,other);res.json({status:'pending'});
});
app.get('/api/friends', auth, (req,res)=>{
  const rows=db.prepare(`SELECT f.requester_id,f.addressee_id,f.status,u.id,u.username,u.status_text,u.accent,u.created_at FROM friends f JOIN users u ON u.id=CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END WHERE f.requester_id=? OR f.addressee_id=? ORDER BY f.created_at DESC`).all(req.user.id,req.user.id,req.user.id);
  res.json(rows.map(r=>({user:userView(r),status:r.status,incoming:r.addressee_id===req.user.id&&r.status==='pending'})));
});

app.get('/api/dms', auth, (req, res) => {
  const rows = db.prepare(`SELECT u.id,u.username,u.accent,u.status_text,
    (SELECT content FROM direct_messages d WHERE (d.sender_id=? AND d.recipient_id=u.id) OR (d.sender_id=u.id AND d.recipient_id=?) ORDER BY d.id DESC LIMIT 1) last_message,
    (SELECT created_at FROM direct_messages d WHERE (d.sender_id=? AND d.recipient_id=u.id) OR (d.sender_id=u.id AND d.recipient_id=?) ORDER BY d.id DESC LIMIT 1) last_at
    FROM users u WHERE u.id<>? AND EXISTS(SELECT 1 FROM direct_messages d WHERE (d.sender_id=? AND d.recipient_id=u.id) OR (d.sender_id=u.id AND d.recipient_id=?))
    ORDER BY last_at DESC`).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
  res.json(rows.map(r => ({ user:userView(r), lastMessage:r.last_message, lastAt:r.last_at })));
});

app.get('/api/dms/:userId/messages', auth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.userId);
  if (!other) return res.status(404).json({ error: 'Пользователь не найден.' });
  const rows = db.prepare(`SELECT d.*,u.username,u.accent,u.status_text FROM
    (SELECT * FROM direct_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id DESC LIMIT 80) d
    JOIN users u ON u.id=d.sender_id ORDER BY d.id`).all(req.user.id, other.id, other.id, req.user.id);
  res.json({ user:userView(other), messages:rows.map(messageView) });
});

app.get('/api/search',auth,(req,res)=>{
  const q=clean(req.query.q,80);if(q.length<2)return res.json([]);const like=`%${q}%`;
  const channels=db.prepare(`SELECT m.id,m.content,m.created_at,u.username,u.accent,c.id channel_id,c.name channel_name,s.name space_name FROM channel_messages m JOIN users u ON u.id=m.user_id JOIN channels c ON c.id=m.channel_id JOIN spaces s ON s.id=c.space_id JOIN space_members sm ON sm.space_id=s.id WHERE sm.user_id=? AND m.content LIKE ? ORDER BY m.id DESC LIMIT 35`).all(req.user.id,like);
  const dms=db.prepare(`SELECT d.id,d.content,d.created_at,u.username,u.accent,CASE WHEN d.sender_id=? THEN d.recipient_id ELSE d.sender_id END other_id FROM direct_messages d JOIN users u ON u.id=d.sender_id WHERE (d.sender_id=? OR d.recipient_id=?) AND d.content LIKE ? ORDER BY d.id DESC LIMIT 20`).all(req.user.id,req.user.id,req.user.id,like);
  res.json([...channels.map(x=>({...x,type:'channel'})),...dms.map(x=>({...x,type:'dm'}))].sort((a,b)=>b.id-a.id).slice(0,40));
});
app.get('/api/channels/:id/pins',auth,(req,res)=>{if(!channelAccess(req.params.id,req.user.id))return res.status(403).json({error:'Нет доступа.'});const rows=db.prepare(`SELECT m.*,u.username,u.accent,u.status_text FROM pinned_messages p JOIN channel_messages m ON m.id=p.message_id JOIN users u ON u.id=m.user_id WHERE p.message_type='channel' AND p.channel_id=? ORDER BY p.created_at DESC`).all(req.params.id);res.json(rows.map(messageView))});
app.post('/api/messages/channel/:id/pin',auth,(req,res)=>{const msg=db.prepare('SELECT channel_id FROM channel_messages WHERE id=?').get(req.params.id);if(!msg||!channelAccess(msg.channel_id,req.user.id))return res.status(403).json({error:'Нет доступа.'});const old=db.prepare("SELECT 1 FROM pinned_messages WHERE message_type='channel' AND message_id=?").get(req.params.id);if(old)db.prepare("DELETE FROM pinned_messages WHERE message_type='channel' AND message_id=?").run(req.params.id);else db.prepare("INSERT INTO pinned_messages(message_type,message_id,channel_id,pinned_by) VALUES('channel',?,?,?)").run(req.params.id,msg.channel_id,req.user.id);io.to(`channel:${msg.channel_id}`).emit('pins:changed',{channelId:msg.channel_id});res.json({pinned:!old})});

app.delete('/api/messages/:type/:id', auth, (req, res) => {
  const table = req.params.type === 'channel' ? 'channel_messages' : req.params.type === 'dm' ? 'direct_messages' : null;
  if (!table) return res.status(400).json({ error: 'Неверный тип.' });
  const result = db.prepare(`DELETE FROM ${table} WHERE id=? AND ${table === 'channel_messages' ? 'user_id' : 'sender_id'}=?`).run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Сообщение не найдено.' });
  db.prepare('DELETE FROM pinned_messages WHERE message_type=? AND message_id=?').run(req.params.type,req.params.id);
  io.emit('message:deleted', { type:req.params.type, id:Number(req.params.id) });
  res.json({ ok:true });
});
app.patch('/api/messages/:type/:id',auth,(req,res)=>{
  const table=req.params.type==='channel'?'channel_messages':req.params.type==='dm'?'direct_messages':null;if(!table)return res.status(400).json({error:'Неверный тип.'});
  const content=clean(req.body.content,2000);if(!content)return res.status(400).json({error:'Сообщение не может быть пустым.'});
  const owner=table==='channel_messages'?'user_id':'sender_id';const out=db.prepare(`UPDATE ${table} SET content=?,edited=1 WHERE id=? AND ${owner}=?`).run(content,req.params.id,req.user.id);
  if(!out.changes)return res.status(404).json({error:'Сообщение не найдено.'});io.emit('message:edited',{type:req.params.type,id:Number(req.params.id),content});res.json({ok:true});
});
app.post('/api/messages/:type/:id/reactions',auth,(req,res)=>{
  const type=req.params.type==='channel'?'channel':req.params.type==='dm'?'dm':null;const emoji=clean(req.body.emoji,4);if(!type||!['👍','❤️','🔥','😂','🎉'].includes(emoji))return res.status(400).json({error:'Недоступная реакция.'});
  if(type==='channel'){const msg=db.prepare('SELECT channel_id FROM channel_messages WHERE id=?').get(req.params.id);if(!msg||!channelAccess(msg.channel_id,req.user.id))return res.status(403).json({error:'Нет доступа.'})}else{const msg=db.prepare('SELECT sender_id,recipient_id FROM direct_messages WHERE id=?').get(req.params.id);if(!msg||![msg.sender_id,msg.recipient_id].includes(req.user.id))return res.status(403).json({error:'Нет доступа.'})}
  const existing=db.prepare('SELECT 1 FROM message_reactions WHERE message_type=? AND message_id=? AND user_id=? AND emoji=?').get(type,req.params.id,req.user.id,emoji);
  if(existing)db.prepare('DELETE FROM message_reactions WHERE message_type=? AND message_id=? AND user_id=? AND emoji=?').run(type,req.params.id,req.user.id,emoji);else db.prepare('INSERT INTO message_reactions(message_type,message_id,user_id,emoji) VALUES(?,?,?,?)').run(type,req.params.id,req.user.id,emoji);
  io.emit('message:reaction',{type,id:Number(req.params.id),emoji,userId:req.user.id,active:!existing});res.json({active:!existing});
});

const online = new Map();
const voiceMembers = new Map();
function leaveVoice(socket){const channelId=socket.voiceChannel;if(!channelId)return;const room=`voice:${channelId}`;socket.leave(room);const members=voiceMembers.get(channelId)||new Map();members.delete(socket.id);if(members.size)voiceMembers.set(channelId,members);else voiceMembers.delete(channelId);socket.to(room).emit('voice:user-left',{socketId:socket.id,userId:socket.user.id});socket.voiceChannel=null}
io.use((socket, next) => {
  try { socket.user = jwt.verify(socket.handshake.auth?.token, JWT_SECRET); next(); }
  catch { next(new Error('unauthorized')); }
});

io.on('connection', socket => {
  const uid = socket.user.id;
  online.set(uid, (online.get(uid) || 0) + 1);
  socket.join(`user:${uid}`);
  io.emit('presence', { userId:uid, online:true });
  socket.emit('presence:list', [...online.keys()]);

  socket.on('channel:join', ({ channelId } = {}) => {
    if (channelAccess(Number(channelId), uid)) socket.join(`channel:${Number(channelId)}`);
  });
  socket.on('channel:leave', ({ channelId } = {}) => socket.leave(`channel:${Number(channelId)}`));
  socket.on('channel:send', ({ channelId, content, replyTo, attachment } = {}, done = () => {}) => {
    channelId = Number(channelId); content = clean(content, 2000); replyTo=Number(replyTo)||null;attachment=attachment&&String(attachment.url||'').startsWith('/uploads/')?{url:clean(attachment.url,240),name:clean(attachment.name,120),type:clean(attachment.type,80)}:null;
    if ((!content&&!attachment) || !channelAccess(channelId, uid)) return done({ error:'Сообщение не отправлено.' });
    if(replyTo&&!db.prepare('SELECT 1 FROM channel_messages WHERE id=? AND channel_id=?').get(replyTo,channelId))replyTo=null;
    const result = db.prepare('INSERT INTO channel_messages(channel_id,user_id,content,reply_to_id,attachment_url,attachment_name,attachment_type) VALUES(?,?,?,?,?,?,?)').run(channelId, uid, content,replyTo,attachment?.url||null,attachment?.name||null,attachment?.type||null);
    const row = db.prepare('SELECT m.*,u.username,u.accent,u.status_text FROM channel_messages m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(result.lastInsertRowid);
    const message = messageView(row); io.to(`channel:${channelId}`).emit('channel:message', { channelId, message }); done({ ok:true });
  });
  socket.on('dm:send', ({ recipientId, content, replyTo, attachment } = {}, done = () => {}) => {
    recipientId = Number(recipientId); content = clean(content, 2000);replyTo=Number(replyTo)||null;attachment=attachment&&String(attachment.url||'').startsWith('/uploads/')?{url:clean(attachment.url,240),name:clean(attachment.name,120),type:clean(attachment.type,80)}:null;
    if ((!content&&!attachment) || recipientId === uid || !db.prepare('SELECT 1 FROM users WHERE id=?').get(recipientId)) return done({ error:'Сообщение не отправлено.' });
    if(replyTo&&!db.prepare('SELECT 1 FROM direct_messages WHERE id=? AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))').get(replyTo,uid,recipientId,recipientId,uid))replyTo=null;
    const result = db.prepare('INSERT INTO direct_messages(sender_id,recipient_id,content,reply_to_id,attachment_url,attachment_name,attachment_type) VALUES(?,?,?,?,?,?,?)').run(uid, recipientId, content,replyTo,attachment?.url||null,attachment?.name||null,attachment?.type||null);
    const row = db.prepare('SELECT d.*,u.username,u.accent,u.status_text FROM direct_messages d JOIN users u ON u.id=d.sender_id WHERE d.id=?').get(result.lastInsertRowid);
    const message = messageView(row); io.to(`user:${uid}`).to(`user:${recipientId}`).emit('dm:message', { senderId:uid, recipientId, message }); done({ ok:true });
  });
  socket.on('typing', ({ type, id, active } = {}) => {
    if (type === 'channel' && channelAccess(Number(id), uid)) socket.to(`channel:${Number(id)}`).emit('typing', { type, id:Number(id), userId:uid, username:socket.user.username, active:!!active });
    if (type === 'dm' && Number(id) !== uid) io.to(`user:${Number(id)}`).emit('typing', { type, id:uid, userId:uid, username:socket.user.username, active:!!active });
  });
  socket.on('voice:join',({channelId}={},done=()=>{})=>{
    channelId=Number(channelId);const channel=db.prepare(`SELECT vc.* FROM voice_channels vc JOIN space_members sm ON sm.space_id=vc.space_id WHERE vc.id=? AND sm.user_id=?`).get(channelId,uid);if(!channel)return done({error:'Нет доступа к голосовому каналу.'});leaveVoice(socket);socket.voiceChannel=channelId;const room=`voice:${channelId}`;const members=voiceMembers.get(channelId)||new Map();const existing=[...members.entries()].map(([socketId,u])=>({socketId,...u}));const user=db.prepare('SELECT username,accent FROM users WHERE id=?').get(uid);members.set(socket.id,{userId:uid,username:user.username,accent:user.accent,muted:false});voiceMembers.set(channelId,members);socket.join(room);socket.emit('voice:members',{channelId,members:existing});socket.to(room).emit('voice:user-joined',{socketId:socket.id,userId:uid,username:user.username,accent:user.accent});io.to(room).emit('voice:state',{channelId,count:members.size});done({ok:true,name:channel.name})
  });
  socket.on('voice:signal',({target,signal}={})=>{if(socket.voiceChannel&&target)io.to(target).emit('voice:signal',{from:socket.id,signal,userId:uid})});
  socket.on('voice:mute',({muted}={})=>{const id=socket.voiceChannel,members=voiceMembers.get(id);if(members?.has(socket.id)){members.get(socket.id).muted=!!muted;if(muted)members.get(socket.id).speaking=false;io.to(`voice:${id}`).emit('voice:mute',{socketId:socket.id,userId:uid,muted:!!muted})}});
  socket.on('voice:speaking',({speaking}={})=>{const id=socket.voiceChannel,members=voiceMembers.get(id);if(members?.has(socket.id)){const member=members.get(socket.id);member.speaking=!!speaking&&!member.muted;io.to(`voice:${id}`).emit('voice:speaking',{socketId:socket.id,userId:uid,speaking:member.speaking})}});
  socket.on('voice:leave',()=>leaveVoice(socket));
  socket.on('disconnect', () => {
    leaveVoice(socket);
    const count = (online.get(uid) || 1) - 1;
    if (count <= 0) { online.delete(uid); io.emit('presence', { userId:uid, online:false }); }
    else online.set(uid, count);
  });
});

app.use(express.static(publicDir));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`Pulse запущен: http://0.0.0.0:${PORT}`));
