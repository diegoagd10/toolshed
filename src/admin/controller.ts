import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { css, js } from './assets.js'
import { AdminContext } from './context.js'
import type { Html } from './html.js'
import { activityPage, keysPage, loginPage, type Notice, startPage, toolsPage } from './pages.js'

const cookie = 'toolshed_session'
const cookiePattern = /(?:^|;\s*)toolshed_session=([\w-]+)/

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}

const loginForm = z.object({ password: z.string() })
  .catch({ password: '' })
const pairForm = z.object({ code: z.string() })
  .catch({ code: '' })
const keyForm = z.object({
  name: z.string()
    .trim()
    .min(1)
    .max(60),
})

function tokenOf(request: Request) {
  return cookiePattern.exec(request.headers.cookie ?? '')?.[1] ?? ''
}

function send(response: Response, status: number, type: string, body: string) {
  response.status(status)
    .set(headers)
    .type(type)
    .send(body)
}

function page(response: Response, status: number, body: Html) {
  send(response, status, 'html', body.value)
}

function redirect(response: Response, path: string) {
  response.status(303)
    .set(headers)
    .location(path)
    .end()
}

@Controller()
export class AdminController {
  readonly #context: AdminContext

  constructor(@Inject(AdminContext) context: AdminContext) {
    this.#context = context
  }

  // A signed-in owner, or undefined after answering with the login page.
  #owner(request: Request, response: Response) {
    const token = tokenOf(request)
    if (this.#context.validSession(token)) return token
    redirect(response, '/login')
    return undefined
  }

  // Every change needs a POST from the dashboard's own origin: a form on another site cannot.
  #sameOrigin(request: Request, response: Response) {
    if (request.headers.origin === this.#context.config.ADMIN_URL) return true
    send(response, 403, 'text', 'This form must be sent from the dashboard.')
    return false
  }

  @Get('health')
  health() {
    return { ok: true }
  }

  @Get('app.css')
  css(@Res() response: Response) {
    send(response, 200, 'css', css)
  }

  @Get('app.js')
  js(@Res() response: Response) {
    send(response, 200, 'js', js)
  }

  @Get('login')
  loginForm(@Req() request: Request, @Res() response: Response) {
    if (this.#context.validSession(tokenOf(request))) return redirect(response, '/')
    page(response, 200, loginPage(false))
  }

  @Post('login')
  login(@Req() request: Request, @Res() response: Response) {
    if (!this.#sameOrigin(request, response)) return
    const { limiter } = this.#context
    const wait = limiter.wait()
    if (wait > 0) {
      response.set('Retry-After', String(wait))
      return page(response, 429, loginPage(`Too many wrong passwords. Try again in ${wait} s.`))
    }
    if (!this.#context.passwordMatches(loginForm.parse(request.body).password)) {
      limiter.add()
      return page(response, 401, loginPage('Wrong password.'))
    }
    const { token, maxAge } = this.#context.openSession()
    const secure = this.#context.config.ADMIN_URL.startsWith('https:') ? '; Secure' : ''
    response.set('Set-Cookie', `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`)
    redirect(response, '/')
  }

  @Post('logout')
  logout(@Req() request: Request, @Res() response: Response) {
    if (!this.#sameOrigin(request, response)) return
    this.#context.closeSession(tokenOf(request))
    response.set('Set-Cookie', `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    redirect(response, '/login')
  }

  #start(response: Response, status: number, notice: Notice | false) {
    const { config, store } = this.#context
    const active = store.keys.list()
      .filter((key) => key.revokedAt === null).length
    page(response, status, startPage(config.PUBLIC_URL, active, store.calls.recent(1)[0], notice))
  }

  @Get()
  start(@Req() request: Request, @Res() response: Response) {
    const token = this.#owner(request, response)
    if (!token) return
    this.#start(response, 200, this.#context.takeNotice(token) ?? false)
  }

  // The owner types the code the agent showed. Pending codes are never listed anywhere.
  @Post('pair/approve')
  approvePair(@Req() request: Request, @Res() response: Response) {
    if (!this.#sameOrigin(request, response)) return
    const token = this.#owner(request, response)
    if (!token) return
    const { pairs, pairLimiter } = this.#context
    const wait = pairLimiter.wait()
    if (wait > 0) {
      response.set('Retry-After', String(wait))
      return this.#start(response, 429, { ok: false, text: `Too many wrong codes. Try again in ${wait} s.` })
    }
    const agent = pairs.approve(pairForm.parse(request.body).code)
    if (agent === undefined) {
      pairLimiter.add()
      const text = 'No agent is waiting with that code. Check it and type it again.'
      return this.#start(response, 422, { ok: false, text })
    }
    this.#context.notify(token, { ok: true, text: `Approved ${agent}. It gets its own key now.` })
    redirect(response, '/')
  }

  @Get('tools')
  tools(@Req() request: Request, @Res() response: Response) {
    if (!this.#owner(request, response)) return
    page(response, 200, toolsPage())
  }

  @Get('keys')
  keys(@Req() request: Request, @Res() response: Response) {
    const token = this.#owner(request, response)
    if (!token) return
    const created = this.#context.takeCreated(token)
    page(response, 200, keysPage(this.#context.store.keys.list(), created ?? false, false))
  }

  @Post('keys')
  createKey(@Req() request: Request, @Res() response: Response) {
    if (!this.#sameOrigin(request, response)) return
    const token = this.#owner(request, response)
    if (!token) return
    const { store } = this.#context
    const parsed = keyForm.safeParse(request.body)
    if (!parsed.success) {
      const error = 'Give the key a name of 1 to 60 characters.'
      return page(response, 422, keysPage(store.keys.list(), false, error))
    }
    const { key, secret } = store.keys.create(parsed.data.name)
    this.#context.remember(token, { name: key.name, secret })
    redirect(response, '/keys')
  }

  @Post('keys/:id/revoke')
  revoke(@Param('id') id: string, @Req() request: Request, @Res() response: Response) {
    if (!this.#sameOrigin(request, response)) return
    if (!this.#owner(request, response)) return
    this.#context.store.keys.revoke(id)
    redirect(response, '/keys')
  }

  @Get('activity')
  activity(@Req() request: Request, @Res() response: Response) {
    if (!this.#owner(request, response)) return
    const { store } = this.#context
    page(response, 200, activityPage(store.calls.recent(100), store.keys.list()))
  }
}
