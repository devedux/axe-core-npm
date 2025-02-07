import fs from 'fs';
import assert from 'assert';
import cssesc from 'cssesc';
import {
  isWebdriverClient,
  normalizeContext,
  logOrRethrowError,
  axeSourceInject,
  axeGetFrameContext,
  axeRunPartial,
  axeFinishRun,
  axeRunLegacy
} from './utils';

import type { Browser } from 'webdriverio';
import type { RunOptions, AxeResults, ContextObject } from 'axe-core';
import type {
  Options,
  CallbackFunction,
  WdioBrowser,
  WdioElement,
  PartialResults,
  Selector
} from './types';

export default class AxeBuilder {
  private client: Browser<'async'>;
  private axeSource: string;
  private includes: Selector[] = [];
  private excludes: Selector[] = [];
  private option: RunOptions = {};
  private disableFrameSelectors: string[] = [];
  private legacyMode = false;

  constructor({ client, axeSource }: Options) {
    assert(
      isWebdriverClient(client),
      'An instantiated WebdriverIO client greater than v5 is required'
    );
    // Treat everything as Browser<'async'>:
    // - Anything sync can also run async, since JS can await sync functions
    // - Ignore MultiRemoteBrowser, which is just Browser with extra props
    this.client = client as Browser<'async'>;

    if (axeSource) {
      this.axeSource = axeSource;
    } else {
      const sourceDir = require.resolve('axe-core');
      try {
        this.axeSource = fs.readFileSync(sourceDir, 'utf-8');
      } catch (e) {
        throw new Error(
          'Unable to find axe-core source. Is axe-core installed?'
        );
      }
    }
  }

  /**
   * Disable injecting axe-core into frame(s) matching the
   * given CSS `selector`. This method may be called any number of times.
   */
  public disableFrame(selector: string): this {
    this.disableFrameSelectors.push(cssesc(selector));
    return this;
  }

  /**
   * Selector to include in analysis.
   * This may be called any number of times.
   */
  public include(selector: Selector): this {
    selector = Array.isArray(selector) ? selector : [selector];
    this.includes.push(selector);
    return this;
  }

  /**
   * Selector to exclude in analysis.
   * This may be called any number of times.
   */
  public exclude(selector: Selector): this {
    selector = Array.isArray(selector) ? selector : [selector];
    this.excludes.push(selector);
    return this;
  }

  /**
   * Set options to be passed into axe-core
   */
  public options(options: RunOptions): this {
    this.option = options;
    return this;
  }

  /**
   * Limit analysis to only the specified rules.
   * Cannot be used with `AxeBuilder#withTags`
   */
  public withRules(rules: string | string[]): this {
    rules = Array.isArray(rules) ? rules : [rules];
    this.option.runOnly = {
      type: 'rule',
      values: rules
    };

    return this;
  }

  /**
   * Limit analysis to only specified tags.
   * Cannot be used with `AxeBuilder#withRules`
   */
  public withTags(tags: string | string[]): this {
    tags = Array.isArray(tags) ? tags : [tags];
    this.option.runOnly = {
      type: 'tag',
      values: tags
    };
    return this;
  }

  /**
   * Set the list of rules to skip when running an analysis.
   */
  public disableRules(rules: string | string[]): this {
    rules = Array.isArray(rules) ? rules : [rules];
    this.option.rules = {};

    for (const rule of rules) {
      this.option.rules[rule] = { enabled: false };
    }

    return this;
  }

  /**
   * Use frameMessenger with <same_origin_only>
   *
   * This disables use of axe.runPartial() which is called in each frame, and
   * axe.finishRun() which is called in a blank page. This uses axe.run() instead,
   * but with the restriction that cross-origin frames will not be tested.
   */
  public setLegacyMode(legacyMode = true): this {
    this.legacyMode = legacyMode;
    return this;
  }

  /**
   * Performs an analysis and retrieves results.
   */
  public async analyze(callback?: CallbackFunction): Promise<AxeResults> {
    return new Promise((resolve, reject) => {
      return this.analyzePromise()
        .then((results: AxeResults) => {
          callback?.(null, results);
          resolve(results);
        })
        .catch((err: Error) => {
          // When using a callback, do *not* reject the wrapping Promise. This prevents having to handle the same error twice.
          if (callback) {
            callback(err.message, null);
          } else {
            reject(err);
          }
        });
    });
  }

  /**
   * Get axe-core source and configurations
   */
  private get script(): string {
    return `
      ${this.axeSource}
      axe.configure({
        ${this.legacyMode ? '' : `allowedOrigins: ['<unsafe_all_origins>'],`}
        branding: { application: 'webdriverio' }
      })
      `;
  }

  /**
   * Injects `axe-core` into all frames.
   */
  private async inject(
    browsingContext: WdioElement | null = null
  ): Promise<void> {
    await this.setBrowsingContext(browsingContext);
    await this.client.execute(this.script);

    const frames = (await this.client.$$(this.frameSelector())) || [];
    const iframes =
      frames.concat(await this.client.$$(this.iframeSelector())) || [];
    if (!iframes.length) {
      return;
    }

    for (const iframe of iframes) {
      try {
        if (!(await iframe.isExisting())) {
          continue;
        }
        await this.inject(iframe);
        await this.client.switchToParentFrame();
      } catch (error) {
        logOrRethrowError(error);
      }
    }
  }

  private async analyzePromise(): Promise<AxeResults> {
    const { client, axeSource } = this;
    const context = normalizeContext(
      this.includes,
      this.excludes,
      this.disableFrameSelectors
    );

    const runPartialSupported = await axeSourceInject(client, axeSource);
    if (!runPartialSupported || this.legacyMode) {
      return await this.runLegacy(context);
    }
    const partials = await this.runPartialRecursive(context);

    try {
      return await this.finishRun(partials);
    } catch (error) {
      throw new Error(
        `${
          (error as Error).message
        }\n Please check out https://github.com/dequelabs/axe-core-npm/blob/develop/packages/webdriverio/error-handling.md`
      );
    }
  }

  private async runLegacy(context: ContextObject): Promise<AxeResults> {
    const { client, option } = this;
    await this.inject();
    return axeRunLegacy(client, context, option);
  }

  /**
   * Get a CSS selector for retrieving child iframes.
   */
  private iframeSelector(): string {
    let selector = 'iframe';
    for (const disableFrameSelector of this.disableFrameSelectors) {
      selector += `:not(${disableFrameSelector})`;
    }
    return selector;
  }

  /**
   * Get a CSS selector for retrieving child frames.
   */
  private frameSelector(): string {
    let selector = 'frame';
    for (const disableFrameSelector of this.disableFrameSelectors) {
      selector += `:not(${disableFrameSelector})`;
    }
    return selector;
  }

  /**
   * Set browsing context - when `null` sets top level page as context
   * - https://webdriver.io/docs/api/webdriver.html#switchtoframe
   */
  private async setBrowsingContext(
    id: null | WdioElement | WdioBrowser = null
  ): Promise<void> {
    if (id) {
      await this.client.switchToFrame(id);
    } else {
      await this.client.switchToParentFrame();
    }
  }

  /**
   * Get partial results from the current context and its child frames
   * @param {ContextObject} context
   */

  private async runPartialRecursive(
    context: ContextObject
  ): Promise<PartialResults> {
    const frameContexts = await axeGetFrameContext(this.client, context);
    const partials: PartialResults = [
      await axeRunPartial(this.client, context, this.option)
    ];

    for (const { frameSelector, frameContext } of frameContexts) {
      try {
        const frame = await this.client.$(frameSelector);
        assert(frame, `Expect frame of "${frameSelector}" to be defined`);
        await this.client.switchToFrame(frame);
        await axeSourceInject(this.client, this.script);
        partials.push(...(await this.runPartialRecursive(frameContext)));
      } catch (error) {
        partials.push(null);
        await this.client.switchToParentFrame();
      }
    }
    await this.client.switchToParentFrame();
    return partials;
  }

  private async finishRun(partials: PartialResults): Promise<AxeResults> {
    const { client, axeSource, option } = this;
    const win = await client.getWindowHandle();
    const newWindow = await client.createWindow('tab');
    assert(
      newWindow.handle,
      'Please make sure that you have popup blockers disabled.'
    );

    try {
      await client.switchToWindow(newWindow.handle);
      await client.url('about:blank');
    } catch (error) {
      throw new Error(
        `switchToWindow failed. Are you using updated browser drivers? \nDriver reported:\n${
          (error as Error).message
        }`
      );
    }

    const res = await axeFinishRun(client, axeSource, partials, option);
    // Cleanup
    await client.closeWindow();
    await client.switchToWindow(win);

    return res;
  }
}
