import chalk from "chalk";
import fs from "fs";
import puppeteer from "puppeteer";
import type { Browser, Page } from "puppeteer";
import request from 'request'

import type { Lang } from "./lang";
import { getBoundMessage } from "./messages";

const TIMEOUT_MS = 10000;
const UPLOAD_TIMEOUT_MS = 60000;

interface BasicAuth {
  username: string;
  password: string;
}

const launchBrowser = (
  proxy?: string,
  ignoreDefaultArgs?: string[]
): Promise<Browser> => {
  const args = proxy ? [`--proxy-server=${proxy}`] : [];
  return puppeteer.launch({ args, ignoreDefaultArgs });
};

const readyForUpload = async (
  browser: Browser,
  baseUrl: string,
  userName: string,
  password: string,
  lang: Lang,
  basicAuth?: BasicAuth,
  pfx?: string,
  passphrase?: string
): Promise<Page> => {
  const m = getBoundMessage(lang);

  const page = await browser.newPage();
  const loginUrl = `${baseUrl}/login?saml=off`;

  if (pfx && passphrase) {
    await page.setRequestInterception(true)
    const cert = fs.promises.readFile(pfx)
    page.on('request', interceptedRequest => {
      // Intercept Request, pull out request options, add in client cert
      const options = {
        uri: interceptedRequest.url(),
        method: interceptedRequest.method(),
        headers: interceptedRequest.headers(),
        body: interceptedRequest.postData(),
        pfx: cert,
        passphrase
      };

      // Fire off the request manually (example is using using 'request' lib)
      request(options, function (err, resp, body) {
        // Abort interceptedRequest on error
        if (err) {
          console.error(`Unable to call ${options.uri}`, err);
          return interceptedRequest.abort('connectionrefused');
        }

        // Return retrieved response to interceptedRequest
        interceptedRequest.respond({
          status: resp.statusCode,
          contentType: resp.headers['content-type'],
          headers: resp.headers,
          body: body
        });
      });

    });
  }

  if (basicAuth) {
    await page.authenticate(basicAuth);
  }

  console.log(`Open ${loginUrl}`);
  await page.goto(loginUrl);
  try {
    await page.waitForSelector(".form-username-slash", { timeout: TIMEOUT_MS });
  } catch (e) {
    throw chalk.red(m("Error_cannotOpenLogin"));
  }
  console.log("Trying to log in...");
  await page.type(".form-username-slash > input.form-text", userName);
  await page.type(".form-password-slash > input.form-text", password);
  await page.click(".login-button");
  try {
    await page.waitForNavigation({
      timeout: TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
  } catch (e) {
    throw chalk.red(m("Error_failedLogin"));
  }

  const pluginUrl = `${baseUrl}/k/admin/system/plugin/`;
  console.log(`Navigate to ${pluginUrl}`);
  await page.goto(pluginUrl);

  try {
    await page.waitForSelector("#page-admin-system-plugin-index-addplugin", {
      timeout: TIMEOUT_MS,
    });
  } catch (e) {
    throw chalk.red(m("Error_adminPrivilege"));
  }
  return page;
};

const upload = async (
  page: Page,
  pluginPath: string,
  lang: Lang
): Promise<void> => {
  const m = getBoundMessage(lang);
  console.log(`Trying to upload ${pluginPath}`);
  await page.click("#page-admin-system-plugin-index-addplugin");

  const file = await page.$('.plupload > input[type="file"]');
  if (file == null) {
    throw new Error('input[type="file"] is not found');
  }
  await file.uploadFile(pluginPath);
  // HACK: `page.click` does not work as expected, so we use `page.evaluate` instead.
  // ref: https://github.com/puppeteer/puppeteer/pull/7097#issuecomment-850348366
  await page.evaluate(() => {
    const button =
      document.querySelector<HTMLButtonElement>('button[name="ok"]');
    if (button) {
      button.click();
    } else {
      throw new Error('button[name="ok"] is not found');
    }
  });
  await page.waitForSelector(".ocean-ui-dialog", {
    hidden: true,
    timeout: UPLOAD_TIMEOUT_MS,
  });
  console.log(`${pluginPath} ${m("Uploaded")}`);
};

interface Option {
  proxyServer?: string;
  watch?: boolean;
  lang: Lang;
  basicAuth?: BasicAuth;
  pfx?: string;
  passphrase?: string;
  puppeteerIgnoreDefaultArgs?: string[];
}

export const run = async (
  baseUrl: string,
  userName: string,
  password: string,
  pluginPath: string,
  options: Option
): Promise<void> => {
  let browser = await launchBrowser(
    options.proxyServer,
    options.puppeteerIgnoreDefaultArgs
  );
  let page: Page;
  const { lang, basicAuth, pfx, passphrase } = options;
  const m = getBoundMessage(lang);
  try {
    page = await readyForUpload(
      browser,
      baseUrl,
      userName,
      password,
      lang,
      basicAuth,
      pfx,
      passphrase
    );
    await upload(page, pluginPath, lang);
    if (options.watch) {
      let uploading = false;
      fs.watch(pluginPath, async () => {
        if (uploading) {
          return;
        }
        try {
          uploading = true;
          await upload(page, pluginPath, lang);
        } catch (e) {
          console.log(e);
          console.log(m("Error_retry"));
          await browser.close();
          browser = await launchBrowser(options.proxyServer);
          page = await readyForUpload(
            browser,
            baseUrl,
            userName,
            password,
            lang,
            basicAuth
          );
          await upload(page, pluginPath, lang);
        } finally {
          uploading = false;
        }
      });
    } else {
      await browser.close();
    }
  } catch (e) {
    console.error(m("Error"), e);
    await browser.close();
  }
};
