/**
 * 定时任务配置纯函数层（单一真源，2026-08-01 自 background.js 原样搬迁 +
 * 吸收 background/settings 两份重复的 DEFAULT_SCHEDULE_CONFIG）：
 * cron 5 段解析（分 时 日 月 周；* / a-b / a,b,c / 步长；星期 7 归一 0；
 * 日期×月份组合解析期拦截）、下一次执行时间计算、配置归一化与校验——
 * 后台 alarm 安装、设置页编辑器实时预览与同步服务 /config/cron 写回三端共用，
 * 校验面必然一致。alarm 的安装/触发仍只在后台。
 *
 * 加载方式：后台 importScripts / 设置页 <script>（挂 globalThis.ScheduleConfig），
 * 同步服务 require（module.exports）。
 */
(function (global) {
  'use strict';

  const DEFAULT_CONFIG = {
    scheduleMode: 'interval',
    scrapeInterval: 6,
    translateInterval: 1,
    scrapeCron: '45 * * * *',
    translateCron: '50 * * * *'
  };

  function toPositiveNumber(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  /** 5 字段白名单归一：mode 只认 cron/interval，interval 必须为正数，cron 串仅 trim。 */
  function normalizeConfig(rawConfig) {
    const config = { ...DEFAULT_CONFIG, ...(rawConfig || {}) };
    return {
      scheduleMode: config.scheduleMode === 'cron' ? 'cron' : 'interval',
      scrapeInterval: toPositiveNumber(config.scrapeInterval, DEFAULT_CONFIG.scrapeInterval),
      translateInterval: toPositiveNumber(config.translateInterval, DEFAULT_CONFIG.translateInterval),
      scrapeCron: String(config.scrapeCron || DEFAULT_CONFIG.scrapeCron).trim(),
      translateCron: String(config.translateCron || DEFAULT_CONFIG.translateCron).trim()
    };
  }

  function getNextCronRun(expression, fromDate = new Date()) {
    const cron = parseSimpleCron(expression);
    const candidate = new Date(fromDate.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // 向后查找上限：4 年 + 1 天。解析期的可行性检查已拦掉其余永不匹配的组合，只剩
    // 2/29 可能要跨过一个以上的平年才命中（从 2026-09-25 起算下一次是 2028-02-29）；
    // 旧上限 366 天会把这条合法表达式误判为「无法计算」。最坏约 210 万次比对、百毫秒级。
    const maxAttempts = (4 * 366 + 1) * 24 * 60;
    for (let i = 0; i < maxAttempts; i++) {
      if (matchesCron(candidate, cron)) {
        return candidate.getTime();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }

    throw new Error(`无法计算下一次 Cron 执行时间: ${expression}`);
  }

  function parseSimpleCron(expression) {
    if (typeof expression !== 'string') {
      throw new Error('Cron 表达式必须是字符串');
    }

    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
      throw new Error(`Cron 表达式需要 5 段: ${expression}`);
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const cron = {
      minute: parseCronField(minute, 0, 59, '分钟'),
      hour: parseCronField(hour, 0, 23, '小时'),
      dayOfMonth: parseCronField(dayOfMonth, 1, 31, '日期'),
      month: parseCronField(month, 1, 12, '月份'),
      dayOfWeek: parseCronField(dayOfWeek, 0, 7, '星期')
    };

    // 日期×月份组合可行性：星期不受限时，纯日期约束必须能落在所选月份里
    // （如 "0 0 31 2 *" 永不匹配；若不在解析期拦截，getNextCronRun 要空转
    // 整个查找窗口（4 年×1440 分钟）才报错，且每次 SW 唤醒都重来一遍）。
    // 2 月按 29 天算：29 号在闰年合法，具体是否可达交给 getNextCronRun 判定。
    if (!cron.dayOfMonth.any && cron.dayOfWeek.any) {
      const MAX_DAY_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const months = cron.month.any ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [...cron.month.values];
      const feasible = months.some(m => [...cron.dayOfMonth.values].some(d => d <= MAX_DAY_IN_MONTH[m - 1]));
      if (!feasible) {
        throw new Error(`日期与月份组合永不匹配: ${expression}`);
      }
    }

    return cron;
  }

  // 数字片段只认十进制非负整数。旧实现直接 Number()：Number('') === 0、'0x1f' → 31、
  // '1e1' → 10，于是多打一个逗号的 '45, * * * *' 被静默解析成 {45, 0}（每小时跑两次），
  // '-5' 成 0-5——写错的表达式照样能保存，含义却变了。
  const CRON_NUMBER = /^\d+$/;

  function parseCronField(field, min, max, label) {
    if (field === '*') return { any: true, values: new Set() };

    const formatError = () => new Error(`${label}字段格式错误: ${field}`);
    const values = new Set();
    for (const part of field.split(',')) {
      const stepSegments = part.split('/');
      if (stepSegments.length > 2) {
        throw formatError();
      }

      const base = stepSegments[0];
      const hasStep = stepSegments.length === 2;
      const step = hasStep ? (CRON_NUMBER.test(stepSegments[1]) ? Number(stepSegments[1]) : NaN) : 1;
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`${label}字段步长错误: ${field}`);
      }

      let rangeStart;
      let rangeEnd;
      if (base === '*') {
        rangeStart = min;
        rangeEnd = max;
      } else if (base.includes('-')) {
        // 区间必须恰好两段：旧写法解构取前两段，'1-2-3' 被静默当成 1-2
        const bounds = base.split('-');
        if (bounds.length !== 2 || !bounds.every(text => CRON_NUMBER.test(text))) throw formatError();
        rangeStart = Number(bounds[0]);
        rangeEnd = Number(bounds[1]);
      } else {
        if (!CRON_NUMBER.test(base)) throw formatError();
        // 单值带步长（'5/15'）各家解释不一：Vixie cron 报错，croner / node-cron 当 5-最大值/15，
        // 旧实现则只取 5。跟 Vixie 直接报错，并提示无歧义的区间写法
        if (hasStep) {
          throw new Error(`${label}字段格式错误: ${field}（单值不能带步长；从 ${base} 起每隔 ${step} 请写成 ${base}-${max}/${step}）`);
        }
        rangeStart = Number(base);
        rangeEnd = Number(base);
      }

      if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
        throw new Error(`${label}字段超出范围: ${field}`);
      }

      for (let value = rangeStart; value <= rangeEnd; value += step) {
        values.add(label === '星期' && value === 7 ? 0 : value);
      }
    }

    return { any: false, values };
  }

  function matchesCron(date, cron) {
    const dayOfMonthMatches = matchesCronField(date.getDate(), cron.dayOfMonth);
    const dayOfWeekMatches = matchesCronField(date.getDay(), cron.dayOfWeek);

    // 「受限」只看解析结果是不是纯 '*'：日期写 '*/2' 也算受限，与受限的星期走 OR。
    // Vixie cron 按字段首字符是不是 '*' 判定（'*/2' 算不受限、走 AND）——这里刻意不跟，
    // 改了会让现有的合法表达式悄悄换语义。
    let dayMatches;
    if (cron.dayOfMonth.any && cron.dayOfWeek.any) {
      dayMatches = true;
    } else if (cron.dayOfMonth.any) {
      dayMatches = dayOfWeekMatches;
    } else if (cron.dayOfWeek.any) {
      dayMatches = dayOfMonthMatches;
    } else {
      // 与常见 cron 语义保持一致：日期和星期同时受限时，任一字段匹配即可。
      dayMatches = dayOfMonthMatches || dayOfWeekMatches;
    }

    return matchesCronField(date.getMinutes(), cron.minute)
      && matchesCronField(date.getHours(), cron.hour)
      && matchesCronField(date.getMonth() + 1, cron.month)
      && dayMatches;
  }

  function matchesCronField(value, field) {
    return field.any || field.values.has(value);
  }

  /**
   * 配置整体校验（保存前强校验用）：cron 模式要求两条表达式都合法（错误按字段
   * 分列返回），interval 模式只要求两个间隔为正数（cron 串宽松保留不校验）。
   */
  function validateConfig(rawConfig) {
    const config = normalizeConfig(rawConfig);
    const errors = {};

    if (config.scheduleMode === 'cron') {
      for (const key of ['scrapeCron', 'translateCron']) {
        try {
          getNextCronRun(config[key]);
        } catch (e) {
          errors[key] = e.message;
        }
      }
    } else {
      // normalizeConfig 已把非正数回落默认值，此处仅防御直传原始对象的调用方
      if (!(Number(config.scrapeInterval) > 0)) errors.scrapeInterval = '抓取间隔必须大于 0';
      if (!(Number(config.translateInterval) > 0)) errors.translateInterval = '翻译间隔必须大于 0';
    }

    return { ok: Object.keys(errors).length === 0, errors, config };
  }

  const api = { DEFAULT_CONFIG, normalizeConfig, parseSimpleCron, matchesCron, getNextCronRun, validateConfig };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.ScheduleConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
