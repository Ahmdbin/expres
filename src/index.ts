import { Window } from 'happy-dom'
import cloudscraper from 'cloudscraper'
import axios from 'axios'
import cheerio from 'cheerio'

class VideoLinkExtractor {
  config: any
  foundUrls: Map<string, Set<string>>
  foundPlyrUrl: Map<string, string>

  constructor(config = {}) {
    this.config = {
      timeout: 5000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      maxRetries: 2,
      ...config
    }
    this.foundUrls = new Map()
    this.foundPlyrUrl = new Map()
  }

  async processSingleUrl(url: string, retry = 0): Promise<{ masterLink: string | null, plyrLink: string | null }> {
    try {
      let html: string
      try {
        html = await cloudscraper.get({
          uri: url,
          headers: { 'User-Agent': this.config.userAgent },
          timeout: this.config.timeout
        })
      } catch (e) {
        html = (await axios.get(url, {
          headers: { 'User-Agent': this.config.userAgent },
          timeout: this.config.timeout
        })).data
      }

      const $ = cheerio.load(html)
      const onclickElement = $('li[onclick]').first()
      let plyrLink: string | null = null

      if (onclickElement.length > 0) {
        const onclickContent = onclickElement.attr('onclick')
        const match = onclickContent?.match(/player_iframe\.location\.href\s*=\s*'(.*?)'/)
        if (match && match[1]) {
          plyrLink = match[1]
          this.foundPlyrUrl.set(url, plyrLink)
        }
      }

      if (plyrLink) {
        try {
          const plyrHtml = (await axios.get(plyrLink, {
            headers: { 'User-Agent': this.config.userAgent },
            timeout: this.config.timeout
          })).data

          const plyrWindow = new Window()
          const plyrDocument = plyrWindow.document
          plyrDocument.write(plyrHtml)
          plyrDocument.close()

          setTimeout(() => plyrWindow.happyDOM.cancelAsync(), 1200)

          const scripts = plyrDocument.querySelectorAll('script')
          scripts.forEach(script => {
            const content = script.textContent || ''
            const match = content.match(/https?:\/\/[^\"]+\.m3u8/gi)
            if (match) {
              match.forEach(link => this.addVideoUrl(link, url))
            }
          })

          const buttons = plyrDocument.querySelectorAll('button.hd_btn')
          buttons.forEach(button => {
            const videoUrl = button.getAttribute('data-url')
            if (videoUrl && videoUrl.includes('.m3u8')) {
              this.addVideoUrl(videoUrl, url)
            }
          })
        } catch (e) {
          console.error(`Error processing player link ${plyrLink}: ${e.message}`)
        }
      }

      return {
        masterLink: this.getMasterLink(url),
        plyrLink: plyrLink
      }
    } catch (err) {
      if (retry < this.config.maxRetries) {
        return this.processSingleUrl(url, retry + 1)
      }
      return { masterLink: null, plyrLink: null }
    }
  }

  addVideoUrl(videoUrl: string, sourceUrl: string) {
    if (!videoUrl || !videoUrl.match(/\.m3u8|scdns\.io|faselhd/i)) return
    if (!this.foundUrls.has(sourceUrl)) this.foundUrls.set(sourceUrl, new Set())
    this.foundUrls.get(sourceUrl)?.add(videoUrl)
  }

  getMasterLink(sourceUrl: string): string | null {
    if (!this.foundUrls.has(sourceUrl)) return null
    const urls = Array.from(this.foundUrls.get(sourceUrl)!)
    return urls.find(url => url.includes('master.m3u8')) || urls[0]
  }

  getPlyrLink(sourceUrl: string): string | null {
    return this.foundPlyrUrl.get(sourceUrl) || null
  }
}
