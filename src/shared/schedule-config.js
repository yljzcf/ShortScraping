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

    // 最多向后查找 366 天，避免非法表达式造成无限循环。
    const maxAttempts = 366 * 24 * 60;
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
    // 366 天×1440 分钟才报错，且每次 SW 唤醒都重来一遍）。
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

  function parseCronField(field, min, max, label) {
    if (field === '*') return { any: true, values: new Set() };

    const values = new Set();
    for (const part of field.split(',')) {
      const stepSegments = part.split('/');
      if (stepSegments.length > 2) {
        throw new Error(`${label}字段格式错误: ${field}`);
      }

      const base = stepSegments[0];
      const step = stepSegments.length === 2 ? Number(stepSegments[1]) : 1;
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`${label}字段步长错误: ${field}`);
      }

      let rangeStart;
      let rangeEnd;
      if (base === '*') {
        rangeStart = min;
        rangeEnd = max;
      } else if (base.includes('-')) {
        const [startText, endText] = base.split('-');
        rangeStart = Number(startText);
        rangeEnd = Number(endText);
      } else {
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
