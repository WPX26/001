/**
 * tabBar 图标生成脚本（Node + jimp）
 * 生成 4 个 tab（首页/相册/消息/我的）× 2 状态（灰/橙）共 8 张 PNG
 * 运行：node scripts/gen-tab-icons.js
 * 输出：src/static/tabbar/
 */
const path = require('path')
const fs = require('fs')
const Jimp = require('jimp')

const OUT_DIR = path.join(__dirname, '..', 'src', 'static', 'tabbar')
const SIZE = 81 // 3 的倍数，便于像素画
const GRAY = 0x9b7b5aff // #9B7B5A 未选中（原型 nav 图标色）
const ORANGE = 0xe89020ff // #E89020 选中（原型 active 色）

/** 填充形状：fn(x, y) -> boolean，true 则涂色 */
async function draw(name, fn) {
  const img = new Jimp(SIZE, SIZE, 0x00000000)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (fn(x, y)) img.setPixelColor(GRAY, x, y)
    }
  }
  await img.writeAsync(path.join(OUT_DIR, name + '.png'))

  const active = img.clone()
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (active.getPixelColor(x, y) !== 0x00000000) active.setPixelColor(ORANGE, x, y)
    }
  }
  await active.writeAsync(path.join(OUT_DIR, name + '-active.png'))
}

// 首页：房子（三角形屋顶 + 方形墙体）
function house(x, y) {
  const cx = 40
  const roof = (x - cx) / (44 - Math.abs(y - 30)) // 简化三角
  // 屋顶：从 (14,36) 到 (66,36) 到 (40,8)
  if (y >= 8 && y <= 36) {
    const t = (y - 8) / 28
    const halfW = 26 * (1 - t) + 4
    if (Math.abs(x - 40) <= halfW) return true
  }
  // 墙体：x 14-66, y 36-72，中间挖门
  if (y >= 36 && y <= 72 && x >= 14 && x <= 66) {
    if (x >= 33 && x <= 47 && y >= 50) return false // 门
    return true
  }
  return false
}

// 相册：三行网格（照片缩略图）
function album(x, y) {
  const cell = 16
  const gap = 5
  const x0 = 12
  const y0 = 10
  if (x < x0 || y < y0) return false
  const row = Math.floor((y - y0) / (cell + gap))
  const col = Math.floor((x - x0) / (cell + gap))
  if (row > 2 || col > 2) return false
  const cx = x0 + col * (cell + gap)
  const cy = y0 + row * (cell + gap)
  return x >= cx && x < cx + cell && y >= cy && y < cy + cell
}

// 消息：圆角气泡 + 尾巴
function message(x, y) {
  // 气泡：x 10-70, y 12-56，圆角
  const rx = (px, py, x1, y1, x2, y2) => {
    if (px < x1 || px > x2 || py < y1 || py > y2) return false
    const r = 8
    const cx = Math.max(x1 + r, Math.min(px, x2 - r))
    const cy = Math.max(y1 + r, Math.min(py, y2 - r))
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) <= r * r
  }
  if (rx(x, y, 10, 12, 70, 56)) return true
  // 尾巴：右下小三角
  if (y >= 52 && y <= 64 && x >= 58 && x <= 70) {
    if (x - 58 <= y - 52 && x >= 70 - (y - 52)) return false
    if (x <= 58 + (y - 52) && x >= 70 - (y - 52)) return true
  }
  return false
}

// 我的：人形（圆头 + 半圆身）
function person(x, y) {
  const cx = 40
  // 头：圆心 (40, 24) 半径 14
  if ((x - 40) * (x - 40) + (y - 24) * (y - 24) <= 14 * 14) return true
  // 身：圆心 (40, 72) 半径 26，只取上半 y <= 72
  if (y >= 46 && y <= 72) {
    const dx = x - 40
    const dy = y - 72
    if (dx * dx + dy * dy <= 26 * 26) return true
  }
  return false
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await draw('home', house)
  await draw('album', album)
  await draw('message', message)
  await draw('profile', person)
  console.log('tabBar icons generated →', OUT_DIR)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
