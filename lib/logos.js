/**
 * logo 文件管理：logos/<名字>.png 目录。名字白名单 + PNG 魔数校验。
 */
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createLogos(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const fp = (name) => path.join(dir, name + '.png');
  const checkName = (name) => { if (!NAME_RE.test(String(name || ''))) throw new Error('logo 名只允许字母数字_-'); };
  return {
    list: () => fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).sort(),
    exists: (name) => NAME_RE.test(String(name || '')) && fs.existsSync(fp(name)),
    pathOf: (name) => (NAME_RE.test(String(name || '')) && fs.existsSync(fp(name)) ? fp(name) : null),
    save: (name, buffer) => {
      checkName(name);
      if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.slice(0, 8).equals(PNG_SIG)) throw new Error('必须是 PNG 图片');
      fs.writeFileSync(fp(name), buffer);
    },
    remove: (name) => { checkName(name); try { fs.unlinkSync(fp(name)); } catch {} },
  };
}

module.exports = { createLogos };
