'use strict';

const crypto = require('node:crypto');
const store = require('./store');
const { AppError, parseCookies } = require('./util');

const COOKIE_NAME = 'moyue_sid';
const SCRYPT_KEYLEN = 64;
const attempts = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expected) {
  if (!salt || !expected) return false;
  try {
    const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  } catch {
    return false;
  }
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/.test(value)) {
    throw new AppError(400, '用户名需为 2–20 位中文、字母、数字或下划线', 'BAD_USERNAME');
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 6 || value.length > 64) {
    throw new AppError(400, '密码长度需为 6–64 位', 'BAD_PASSWORD');
  }
  if (!value.trim()) throw new AppError(400, '密码不能全为空格', 'BAD_PASSWORD');
  return value;
}

function register({ username, password, displayName, ip = '' }) {
  if (!store.settings().allowRegister) {
    throw new AppError(403, '当前已关闭注册', 'REGISTER_CLOSED');
  }
  const name = validateUsername(username);
  const pass = validatePassword(password);
  if (store.findUserByName(name)) {
    throw new AppError(409, '这个用户名已经被使用', 'USER_EXISTS');
  }
  const { salt, hash } = hashPassword(pass);
  const user = store.createUser({
    username: name,
    displayName: String(displayName || '').trim().slice(0, 20) || name,
    passwordHash: hash,
    salt
  });
  const sid = store.createSession(user.id);
  return { user, sid };
}

function login({ username, password, ip = '' }) {
  const key = String(ip || 'local');
  const now = Date.now();
  const record = attempts.get(key);
  if (record && record.resetAt > now && record.count >= 12) {
    const wait = Math.ceil((record.resetAt - now) / 60000);
    throw new AppError(429, `尝试次数过多，请约 ${wait} 分钟后再试`, 'TOO_MANY_ATTEMPTS');
  }
  const user = store.findUserByName(username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    if (!record || record.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + 10 * 60000 });
    } else {
      record.count += 1;
    }
    throw new AppError(401, '用户名或密码不正确', 'BAD_CREDENTIALS');
  }
  attempts.delete(key);
  const sid = store.createSession(user.id);
  return { user, sid };
}

function logout(sid) {
  store.destroySession(sid);
}

function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies[COOKIE_NAME] || '';
  const user = store.userFromSession(sid);
  return { sid, user };
}

function requireUser(req) {
  const { user, sid } = sessionFromRequest(req);
  if (!user) throw new AppError(401, '请先登录', 'UNAUTHORIZED');
  return { user, sid };
}

function changePassword(req, { current, next }) {
  const { user, sid } = requireUser(req);
  if (!verifyPassword(current, user.salt, user.passwordHash)) {
    throw new AppError(400, '当前密码不正确', 'BAD_CREDENTIALS');
  }
  const password = validatePassword(next);
  if (password === current) throw new AppError(400, '新密码不能与当前密码相同', 'SAME_PASSWORD');
  const { salt, hash } = hashPassword(password);
  store.setUserPassword(user.id, hash, salt);
  const newSid = store.createSession(user.id);
  return { sid: newSid, oldSid: sid };
}

function cleanupAttempts() {
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (record.resetAt <= now) attempts.delete(key);
  }
}

const timer = setInterval(cleanupAttempts, 30 * 60000);
if (typeof timer.unref === 'function') timer.unref();

module.exports = {
  COOKIE_NAME,
  register,
  login,
  logout,
  sessionFromRequest,
  requireUser,
  changePassword,
  hashPassword
};
