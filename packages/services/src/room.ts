import { box, type AssetPart, type AssetSpec } from './assetScript.js';

/**
 * The v1 test scene, derived from tests/prompts/test_room.md:
 * a 6.4 × 5.2 × 2.8 m residential room, camera parked in the central aisle at
 * 1.67 m looking slightly down, furniture arranged around the viewer.
 *
 * Coordinates are metres; each item's parts are relative to the item origin.
 */

export interface RoomItem extends AssetSpec {
  position: [number, number, number];
  rotationY: number;
}

const WALL = '#d8d4cd';
const WALL_ALT = '#cfc9c0';
const FLOOR = '#8a6f52';
const WOOD_DARK = '#5c4633';
const FABRIC = '#6d7480';
const METAL = '#8d8d8d';
const PINK = '#c86a8e';
const WARM = '#e0b070';

function part(
  size: [number, number, number],
  at: [number, number, number],
  color: string,
  roughness: number,
): AssetPart {
  return box(size, at, color, roughness);
}

function item(
  id: string,
  semantic: string,
  prompt: string,
  position: [number, number, number],
  parts: AssetPart[],
  palette: string[],
  options: { scaleHint?: AssetSpec['scaleHint']; tags?: string[]; fitDependent?: boolean } = {},
): RoomItem {
  return {
    assetId: id,
    semantic,
    promptFragment: prompt,
    parts,
    palette,
    scaleHint: options.scaleHint ?? 'human',
    styleTags: options.tags ?? ['indoor', 'residential'],
    fitDependent: options.fitDependent,
    position,
    rotationY: 0,
  };
}

export const ROOM_ITEMS: RoomItem[] = [
  item('rm_floor', '木地板', '浅褐色橡木地板，窄板拼接，轻微色差与使用划痕，低光泽', [0, 0, 0], [
    part([6.4, 0.1, 5.2], [0, -0.05, 0], FLOOR, 0.72),
  ], [FLOOR], { scaleHint: 'large', tags: ['wood', 'floor'] }),
  item('rm_ceiling', '天花板', '白色哑光天花，接缝细微，无装饰线脚', [0, 0, 0], [
    part([6.4, 0.1, 5.2], [0, 2.85, 0], '#e6e3dd', 0.9),
  ], ['#e6e3dd'], { scaleHint: 'large', tags: ['paint', 'ceiling'] }),
  item('rm_wall_n', '北墙', '浅灰白乳胶漆墙面，细小颗粒感，靠灯处略亮', [0, 0, -2.6], [
    part([6.4, 2.8, 0.12], [0, 1.4, 0], WALL, 0.88),
  ], [WALL], { scaleHint: 'huge', tags: ['paint', 'wall'] }),
  item('rm_wall_s', '南墙', '浅灰白乳胶漆墙面，被门口光线轻微提亮', [0, 0, 2.6], [
    part([6.4, 2.8, 0.12], [0, 1.4, 0], WALL_ALT, 0.88),
  ], [WALL_ALT], { scaleHint: 'huge', tags: ['paint', 'wall'] }),
  item('rm_wall_e', '东墙', '浅灰白墙面，窗洞边缘有轻微阴影过渡', [3.2, 0, 0], [
    part([0.12, 2.8, 5.2], [0, 1.4, 0], WALL, 0.88),
  ], [WALL], { scaleHint: 'huge', tags: ['paint', 'wall'] }),
  item('rm_wall_w', '西墙', '浅灰白墙面，电视位置有粉色背光的柔和反射', [-3.2, 0, 0], [
    part([0.12, 2.8, 5.2], [0, 1.4, 0], WALL_ALT, 0.88),
  ], [WALL_ALT, PINK], { scaleHint: 'huge', tags: ['paint', 'wall'] }),
  item('rm_window', '窗户', '夜间窗户，玻璃保留轻微环境反射，窗外是细小清晰的城市灯点', [3.18, 1.5, 0.4], [
    part([0.06, 1.25, 1.9], [0, 0, 0], '#1a2233', 0.2),
    part([0.08, 1.35, 0.08], [0, 0, -0.99], '#9a9a96', 0.6),
    part([0.08, 1.35, 0.08], [0, 0, 0.99], '#9a9a96', 0.6),
  ], ['#1a2233', '#9a9a96'], { scaleHint: 'large', tags: ['glass', 'night'] }),
  item('rm_curtain', '窗帘', '灰米色织物窗帘，靠自重垂落，褶皱宽窄自然，透光边缘柔和', [2.98, 0, 1.35], [
    part([0.08, 2.3, 0.95], [0, 1.15, 0], '#a8a093', 0.95),
  ], ['#a8a093'], { scaleHint: 'large', tags: ['fabric', 'curtain'] }),
  item('rm_desk', '工作台', '低光泽木质工作台，近处可见细密木纹与浅划痕，板厚明显', [0.1, 0, -2.1], [
    part([1.9, 0.06, 0.75], [0, 0.74, 0], '#8d6f4f', 0.55),
    part([0.06, 0.72, 0.06], [-0.88, 0.36, -0.32], WOOD_DARK, 0.6),
    part([0.06, 0.72, 0.06], [0.88, 0.36, -0.32], WOOD_DARK, 0.6),
    part([0.06, 0.72, 0.06], [-0.88, 0.36, 0.32], WOOD_DARK, 0.6),
    part([0.06, 0.72, 0.06], [0.88, 0.36, 0.32], WOOD_DARK, 0.6),
  ], ['#8d6f4f', WOOD_DARK], { scaleHint: 'large', tags: ['wood', 'desk'] }),
  item('rm_monitor_a', '显示器', '24 寸显示器，玻璃保留轻微环境反射，屏幕内容自然发光，支架与桌面接触阴影可信', [-0.45, 0.77, -2.18], [
    part([0.62, 0.36, 0.03], [0, 0.45, 0], '#22262b', 0.35),
    part([0.05, 0.24, 0.05], [0, 0.18, 0.02], '#3a3f45', 0.6),
    part([0.2, 0.02, 0.14], [0, 0.06, 0.02], '#3a3f45', 0.6),
  ], ['#22262b', '#3a3f45'], { scaleHint: 'large', tags: ['electronics', 'screen'] }),
  item('rm_monitor_b', '显示器', '同款显示器，屏幕亮度略低，边框有细微磨砂质感', [0.45, 0.77, -2.18], [
    part([0.62, 0.36, 0.03], [0, 0.45, 0], '#22262b', 0.35),
    part([0.05, 0.24, 0.05], [0, 0.18, 0.02], '#3a3f45', 0.6),
    part([0.2, 0.02, 0.14], [0, 0.06, 0.02], '#3a3f45', 0.6),
  ], ['#22262b', '#3a3f45'], { scaleHint: 'large', tags: ['electronics', 'screen'] }),
  item('rm_laptop', '笔记本电脑', '13 寸笔记本，铝壳细磨砂，屏幕半开，键盘区域略有油光', [-0.05, 0.77, -1.92], [
    part([0.32, 0.02, 0.22], [0, 0.02, 0], '#9aa0a6', 0.45),
    part([0.32, 0.21, 0.015], [0, 0.12, -0.1], '#9aa0a6', 0.45),
  ], ['#9aa0a6'], { scaleHint: 'small', tags: ['electronics', 'metal'] }),
  item('rm_keyboard', '键盘', '矮轴机械键盘，键帽边缘略有磨损，塑料壳体亚光', [0.15, 0.77, -1.82], [
    part([0.36, 0.03, 0.13], [0, 0.02, 0], '#3b3b3b', 0.7),
  ], ['#3b3b3b'], { scaleHint: 'small', tags: ['plastic', 'input'] }),
  item('rm_mouse', '鼠标', '无线鼠标，哑光塑料外壳，底部有细微使用痕迹', [0.4, 0.77, -1.82], [
    part([0.07, 0.04, 0.11], [0, 0.02, 0], '#3b3b3b', 0.65),
  ], ['#3b3b3b'], { scaleHint: 'small', tags: ['plastic', 'input'] }),
  item('rm_cup', '杯子', '陶瓷马克杯，只有柔和局部的反光，杯口内侧有水痕', [-0.6, 0.77, -1.85], [
    part([0.085, 0.1, 0.085], [0, 0.05, 0], '#e8e4dc', 0.35),
  ], ['#e8e4dc'], { scaleHint: 'small', tags: ['ceramic'] }),
  item('rm_bookshelf', '书柜', '深木色书柜，层板承重略弯，书脊厚薄不同，纸张边缘有使用感', [-1.7, 0, -2.32], [
    part([1.1, 2.0, 0.3], [0, 1.0, 0], '#5b4632', 0.7),
    part([0.95, 0.04, 0.26], [0, 0.5, 0.02], '#6d5540', 0.7),
    part([0.95, 0.04, 0.26], [0, 1.0, 0.02], '#6d5540', 0.7),
    part([0.95, 0.04, 0.26], [0, 1.5, 0.02], '#6d5540', 0.7),
  ], ['#5b4632', '#6d5540'], { scaleHint: 'large', tags: ['wood', 'book'] }),
  item('rm_guitar', '吉他', '木吉他，靠墙斜放，共鸣箱有木质纹理与细小划痕，金属弦钮反光', [-0.62, 0, -2.28], [
    part([0.34, 0.42, 0.09], [0, 0.45, 0], '#a3763f', 0.5),
    part([0.06, 0.62, 0.04], [0, 0.95, 0], '#3b2c1e', 0.6),
  ], ['#a3763f'], { scaleHint: 'large', tags: ['wood', 'music'] }),
  item('rm_tv_wall', '电视背景墙', '深灰饰面板，粉色背光主要停留在电视周围，向邻近表面形成克制反射', [-3.12, 0, 0.6], [
    part([0.06, 1.9, 2.4], [0, 1.05, 0], '#3c3a3d', 0.85),
  ], ['#3c3a3d', PINK], { scaleHint: 'huge', tags: ['panel', 'accent-light'] }),
  item('rm_tv', '电视', '65 寸电视，屏幕边缘有背光溢出，玻璃面反射室内灯光', [-3.02, 0, 0.6], [
    part([0.05, 0.85, 1.5], [0, 1.3, 0], '#101216', 0.25),
  ], ['#101216', PINK], { scaleHint: 'huge', tags: ['electronics', 'screen'] }),
  item('rm_tv_cabinet', '电视柜', '低矮电视柜，哑光木饰面，柜门缝隙均匀，底部有柔和阴影', [-2.86, 0, 0.6], [
    part([0.36, 0.45, 1.7], [0, 0.23, 0], '#6a5847', 0.75),
  ], ['#6a5847'], { scaleHint: 'large', tags: ['wood', 'cabinet'] }),
  item('rm_sofa', '沙发', '布艺三人沙发，靠垫自然下陷，扶手边缘柔软，织物可见细纤维', [-1.25, 0, 1.9], [
    part([1.9, 0.36, 0.85], [0, 0.2, 0], FABRIC, 0.95),
    part([1.9, 0.5, 0.16], [0, 0.62, -0.34], FABRIC, 0.95),
    part([0.16, 0.5, 0.85], [-0.87, 0.26, 0], FABRIC, 0.95),
    part([0.16, 0.5, 0.85], [0.87, 0.26, 0], FABRIC, 0.95),
  ], [FABRIC], { scaleHint: 'large', tags: ['fabric', 'seating'] }),
  item('rm_armchair', '单人椅', '单人布艺椅，座面有受力褶皱，靠背柔软，颜色略有自然变化', [2.2, 0, 1.35], [
    part([0.78, 0.38, 0.78], [0, 0.2, 0], '#7a6f63', 0.95),
    part([0.78, 0.5, 0.14], [0, 0.62, -0.32], '#7a6f63', 0.95),
  ], ['#7a6f63'], { scaleHint: 'large', tags: ['fabric', 'seating'] }),
  item('rm_floor_lamp', '落地灯', '布艺灯罩透出细密织物结构，暖光向窗帘与地板扩散，灯杆金属哑光', [2.7, 0, -1.35], [
    part([0.3, 0.03, 0.3], [0, 0.015, 0], '#4a4a4a', 0.6),
    part([0.05, 1.5, 0.05], [0, 0.78, 0], METAL, 0.5),
    part([0.34, 0.3, 0.34], [0, 1.62, 0], WARM, 0.9),
  ], [METAL, WARM], { scaleHint: 'large', tags: ['metal', 'light'] }),
  item('rm_plant', '绿植', '盆栽观叶植物，叶片厚薄不一、略微弯曲，边缘有柔和透光', [2.6, 0, 2.05], [
    part([0.28, 0.3, 0.28], [0, 0.15, 0], '#7a5c46', 0.8),
    part([0.5, 0.45, 0.5], [0, 0.52, 0], '#4f6b43', 0.85),
  ], ['#7a5c46', '#4f6b43'], { scaleHint: 'human', tags: ['plant'] }),
  item('rm_low_cabinet', '矮柜', '低矮储物柜，哑光漆面，把手细小，柜顶有少量日常物品', [-2.9, 0, -1.2], [
    part([0.38, 0.55, 1.1], [0, 0.27, 0], '#7d7468', 0.8),
  ], ['#7d7468'], { scaleHint: 'large', tags: ['wood', 'cabinet'] }),
  item('rm_coat_rack', '衣帽架', '金属衣帽架，细杆，挂钩略有磨损，底部配重盘', [-2.75, 0, 2.25], [
    part([0.34, 0.04, 0.34], [0, 0.02, 0], '#3f3f3f', 0.6),
    part([0.045, 1.75, 0.045], [0, 0.9, 0], '#3f3f3f', 0.55),
    part([0.42, 0.035, 0.42], [0, 1.7, 0], '#3f3f3f', 0.55),
  ], ['#3f3f3f'], { scaleHint: 'large', tags: ['metal'] }),
  item('rm_door', '入口门', '室内木门，门缝有细窄阴影，门把手金属微反光', [1.6, 0, 2.58], [
    part([0.9, 2.1, 0.06], [0, 1.05, 0], '#8f8578', 0.8),
    part([0.1, 0.03, 0.05], [0.34, 1.05, 0.05], '#b0b0b0', 0.4),
  ], ['#8f8578', '#b0b0b0'], { scaleHint: 'large', tags: ['wood', 'door'] }),
];

export const ROOM_BOUNDS = {
  min: { x: -3.2, y: 0, z: -2.6 },
  max: { x: 3.2, y: 2.8, z: 2.6 },
};
