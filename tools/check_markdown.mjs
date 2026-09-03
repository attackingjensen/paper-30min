import { renderMarkdown } from '../public/js/markdown.js';

const chineseSentence = renderMarkdown('每个 $簇只与自身对应的潜变量共同评分$，避免串扰。');
if (chineseSentence.includes('$') || !chineseSentence.includes('簇只与自身对应的潜变量共同评分')) {
  throw new Error(`Chinese prose was not restored from math delimiters: ${chineseSentence}`);
}

const ordinaryMath = renderMarkdown('损失函数为 $L = L_{task} + \\lambda L_{aux}$。');
if (!ordinaryMath.includes('$L = L_{task} + \\lambda L_{aux}$')) {
  throw new Error(`Ordinary inline math was not preserved: ${ordinaryMath}`);
}

const mathWithChineseText = renderMarkdown('定义 $L_{\\text{总}} = L_1 + L_2$。');
if (!mathWithChineseText.includes('$L_{\\text{总}} = L_1 + L_2$')) {
  throw new Error(`Chinese text inside a TeX text command was not preserved: ${mathWithChineseText}`);
}

console.log('markdown math boundary checks passed');
