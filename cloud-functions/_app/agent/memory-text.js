// 三层记忆共用的文本工具：停用词、分词、归一化（v7.10.3）
//
// 此前 memory.js / memory-layers.js / prompt.js 各写了一份分词，口径还不一致：
// 其中两份完全没过滤停用词，中文 2-gram「我的 / 这个 / 一下」几乎出现在每个句子里，
// 于是「相关记忆」里混进一堆无关条目，模型反而被误导。统一到这一份后，
// L1 / L2 / L3 的相关性判断才真的一致，也便于一处修、三处生效。
//
// 纯函数、零依赖、零 I/O，可被 selfcheck 直接单测。

// 停用词：中文按「整词」与「2-gram」两种形态都要拦，英文按常见虚词拦。
const MEMORY_STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '就', '不', '也', '都',
  '这', '那', '有', '吗', '呢', '啊', '吧', '呀', '把', '被', '给', '对', '从', '到', '而', '并',
  '一个', '一下', '什么', '怎么', '怎样', '如何', '可以', '能否', '是否', '我们', '你们', '他们',
  '这个', '那个', '这些', '那些', '现在', '然后', '就是', '还是', '没有', '因为', '所以', '如果',
  '但是', '或者', '以及', '进行', '需要', '应该', '已经', '可能', '之后', '之前', '时候', '问题',
  '东西', '帮我', '请问', '告诉', '一些', '这样', '那样', '自己', '知道', '觉得', '想要', '其实',
  '关于', '目前', '直接', '一下', '我的', '你的', '他的', '它的', '你好', '您好', '谢谢', '多谢',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'has', 'but', 'not',
  'can', 'will', 'would', 'could', 'should', 'from', 'they', 'them', 'then', 'than', 'there',
  'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all', 'any', 'our', 'out', 'get', 'got',
]);

// 纯虚词字：两个都是虚词的 2-gram（「我的」「了是」「我们」）没有任何区分度。
// 注意只用于过滤检索 token，不用于主题词抽取——「的」开头的专有名词仍会被主题词逻辑保留。
const FUNC_CHARS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '就', '不', '也', '都',
  '这', '那', '有', '吗', '呢', '啊', '吧', '呀', '把', '被', '给', '对', '从', '到', '而', '并',
  '个', '一', '可', '以', '会', '要', '能', '好', '什', '么', '怎', '如', '何', '请', '帮', '谢',
  '嗯', '着', '过', '很', '更', '最', '又', '再', '还', '只', '才', '已', '将', '让', '向', '于',
  '之', '其', '此', '该', '等', '或', '但',
]);

function isNoiseBigram(g) {
  return g.length === 2 && FUNC_CHARS.has(g.charAt(0)) && FUNC_CHARS.has(g.charAt(1));
}

// 统一分词：英文按词、中文按整段 + 2-gram；过滤停用词与纯虚词碎片。
// 保留中文单字 token（查询就是「猫」这一个字时仍能召回），但单字虚词会被停用词表挡掉。
function memoryTokens(s) {
  const out = [];
  for (const seg of String(s || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!seg) continue;
    if (!MEMORY_STOP_WORDS.has(seg)) out.push(seg);
    if (/[\u4e00-\u9fff]/.test(seg)) {
      for (let i = 0; i + 2 <= seg.length; i++) {
        const g = seg.slice(i, i + 2);
        if (MEMORY_STOP_WORDS.has(g) || isNoiseBigram(g)) continue;
        out.push(g);
      }
    }
  }
  return [...new Set(out)].filter(Boolean);
}

// 归一化：用于去重与「同一条事实」比较（大小写、空白、标点都不影响语义）。
function normalizeMemoryText(s) {
  return String(s || '').toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：,.;!?:：()（）「」《》"']/g, '');
}

// 两段文本的 2-gram 相似度（0~1）。用于识别「同一件事被 L2 和 L3 各记了一遍」。
function textSimilarity(a, b) {
  const x = normalizeMemoryText(a);
  const y = normalizeMemoryText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i + 2 <= s.length; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  if (!gx.size || !gy.size) return 0;
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit++;
  return hit / Math.max(gx.size, gy.size);
}

export {
  MEMORY_STOP_WORDS,
  memoryTokens,
  normalizeMemoryText,
  textSimilarity,
};
