import express from 'express';
import axios from 'axios'; // Changed from node-fetch
import * as cheerio from 'cheerio';
import { chromium as playwrightCore } from 'playwright-core';
import chromium from '@sparticuz/chromium';
const app = express();
const port = process.env.PORT || 3000;
class VideoLinkExtractor {
    config;
    foundUrls;
    foundPlyrUrl;
    constructor(config = {}) {
        this.config = {
            timeout: 5000,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            maxRetries: 2,
            ...config
        };
        this.foundUrls = new Map();
        this.foundPlyrUrl = new Map();
    }
    // New fetch method using axios
    async fetch(url, headers = {}) {
        const res = await axios.get(url, {
            headers: { 'User-Agent': this.config.userAgent, ...headers },
            timeout: this.config.timeout
        });
        return res.data;
    }
    async processSingleUrl(url, retry = 0) {
        try {
            const startTime = Date.now();
            const html = await this.fetch(url);
            const $ = cheerio.load(html);
            let plyrLink = null;
            const onclickElement = $('[onclick*="player_iframe.location.href"]').first();
            if (onclickElement.length > 0) {
                const onclickContent = onclickElement.attr('onclick');
                if (onclickContent) {
                    const match = onclickContent.match(/player_iframe\.location\.href\s*=\s*'(.*?)'/);
                    if (match && match[1]) {
                        plyrLink = match[1];
                        this.foundPlyrUrl.set(url, plyrLink);
                    }
                }
            }
            if (plyrLink) {
                try {
                    // Method 1: Look for .m3u8 in the initial HTML
                    const plyrHtml = await this.fetch(plyrLink, { Referer: url });
                    const m3u8Matches = plyrHtml.match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/gi);
                    if (m3u8Matches) {
                        m3u8Matches.forEach((link) => this.addVideoUrl(link, url));
                    }
                    // Optimization: If we found the master link, we can skip the heavy Playwright part.
                    const masterLink = this.getMasterLink(url);
                    if (masterLink) {
                        const endTime = Date.now();
                        const duration = ((endTime - startTime) / 1000).toFixed(2) + ' seconds';
                        const now = new Date();
                        return {
                            masterLink: masterLink,
                            plyrLink: plyrLink,
                            date: now.toLocaleDateString(),
                            time: now.toLocaleTimeString(),
                            duration: duration
                        };
                    }
                    // Method 2: Use Playwright only if Method 1 fails to find the master link
                    const browser = await playwrightCore.launch({
                        args: chromium.args,
                        executablePath: await chromium.executablePath(),
                        headless: !!chromium.headless,
                    });
                    const page = await browser.newPage();
                    try {
                        await page.goto(plyrLink, { waitUntil: 'domcontentloaded', timeout: 4000 });
                        await page.waitForTimeout(500); // Wait for any dynamic scripts
                        const m3u8Links = await page.evaluate(() => {
                            const out = [];
                            document.querySelectorAll('*').forEach(el => {
                                for (const attr of Array.from(el.attributes)) {
                                    if (attr.value.includes('.m3u8'))
                                        out.push(attr.value);
                                }
                            });
                            document.querySelectorAll('script').forEach(s => {
                                const text = s.textContent || '';
                                const found = text.match(/https?:\/\/[^\s"'<>]+?\.m3u8[^\s"'<>]*/gi);
                                if (found)
                                    out.push(...found);
                            });
                            return [...new Set(out)];
                        });
                        m3u8Links.forEach((link) => this.addVideoUrl(link, url));
                    }
                    catch (err) {
                        console.log('Playwright runtime error:', err.message);
                    }
                    finally {
                        await browser.close();
                    }
                }
                catch (err) {
                    console.log(`Error processing player: ${err.message}`);
                }
            }
            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(2) + ' seconds';
            const now = new Date();
            return {
                masterLink: this.getMasterLink(url),
                plyrLink: plyrLink,
                date: now.toLocaleDateString(),
                time: now.toLocaleTimeString(),
                duration: duration
            };
        }
        catch (err) {
            if (retry < this.config.maxRetries) {
                return this.processSingleUrl(url, retry + 1);
            }
            const now = new Date();
            return {
                masterLink: null,
                plyrLink: null,
                date: now.toLocaleDateString(),
                time: now.toLocaleTimeString(),
                duration: '0 seconds'
            };
        }
    }
    addVideoUrl(videoUrl, sourceUrl) {
        if (!videoUrl || !videoUrl.match(/\.m3u8/))
            return;
        if (!this.foundUrls.has(sourceUrl))
            this.foundUrls.set(sourceUrl, new Set());
        this.foundUrls.get(sourceUrl)?.add(videoUrl);
    }
    getMasterLink(sourceUrl) {
        if (!this.foundUrls.has(sourceUrl))
            return null;
        const urls = Array.from(this.foundUrls.get(sourceUrl) || []);
        return urls.find(u => u.includes('master.m3u8')) || urls[0] || null;
    }
    getPlyrLink(sourceUrl) {
        return this.foundPlyrUrl.get(sourceUrl) || null;
    }
}
export async function extractLinks(url) {
    const extractor = new VideoLinkExtractor();
    return await extractor.processSingleUrl(url);
}
app.get('/', (req, res) => {
    res.type('html').send(`
    <h1>Video Link Extractor API</h1>
    <p>Use the /api/extract endpoint with a 'url' query parameter.</p>
    <p>Example: <a href="/api/extract?url=https://example.com">/api/extract?url=https://example.com</a></p>
    `);
});
app.get('/api/extract', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL query parameter is required.' });
    }
    try {
        const result = await extractLinks(url);
        if (!result.masterLink && !result.plyrLink) {
            return res.status(404).json({ message: 'No video links found.', source: url, ...result });
        }
        res.status(200).json(result);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to extract video links.', details: error.message });
    }
});
export default app;
