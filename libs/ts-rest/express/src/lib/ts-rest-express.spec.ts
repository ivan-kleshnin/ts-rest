import { initContract, ResponseValidationError } from '@ts-rest/core';
import { createExpressEndpoints, initServer } from './ts-rest-express';
import * as supertest from 'supertest';
import * as express from 'express';
import { z } from 'zod';
import * as fs from 'node:fs';
import path = require('path');

const c = initContract();
const postsRouter = c.router({
  getPost: {
    method: 'GET',
    path: `/posts/:id`,
    responses: {
      200: null,
    },
  },
});

describe('strict mode', () => {
  it('allows unknown responses when not in strict mode', () => {
    const cLoose = c.router({ posts: postsRouter });
    const s = initServer();

    s.router(cLoose, {
      posts: {
        getPost: async ({ params: { id } }) => {
          return {
            status: 201,
            body: null,
          };
        },
      },
    });
  });

  it('does not allow unknown statuses when in strict mode', () => {
    const cStrict = c.router(
      { posts: postsRouter },
      { strictStatusCodes: true },
    );
    const s = initServer();

    s.router(cStrict, {
      posts: {
        // @ts-expect-error 201 is not defined as a known response
        getPost: async ({ params: { id } }) => {
          return {
            status: 201,
            body: null,
          };
        },
      },
    });
  });
});

describe('ts-rest-express', () => {
  it('should handle non-json response types from contract', async () => {
    const c = initContract();

    const contract = c.router({
      postIndex: {
        method: 'POST',
        path: `/index.html`,
        body: z.object({
          echoHtml: z.string(),
        }),
        responses: {
          200: c.otherResponse({
            contentType: 'text/html',
            body: z.string().regex(/^<([a-z][a-z0-9]*)\b[^>]*>(.*?)<\/\1>$/im),
          }),
        },
      },
      getRobots: {
        method: 'GET',
        path: `/robots.txt`,
        responses: {
          200: c.otherResponse({
            contentType: 'text/plain',
            body: c.type<string>(),
          }),
        },
      },
      getCss: {
        method: 'GET',
        path: '/style.css',
        responses: {
          200: c.otherResponse({
            contentType: 'text/css',
            body: c.type<string>(),
          }),
        },
      },
    });

    const server = initServer();

    const postIndex = server.route(
      contract.postIndex,
      async ({ body: { echoHtml } }) => {
        return {
          status: 200,
          body: echoHtml,
        };
      },
    );

    const router = server.router(contract, {
      postIndex,
      getRobots: async () => {
        return {
          status: 200,
          body: 'User-agent: * Disallow: /',
        };
      },
      getCss: async () => {
        return {
          status: 200,
          body: 'body { color: red; }',
        };
      },
    });

    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    createExpressEndpoints(contract, router, app, {
      responseValidation: true,
    });

    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        if (err instanceof ResponseValidationError) {
          res.status(500).send('Response validation failed');
          return;
        }

        next(err);
      },
    );

    const responseHtml = await supertest(app)
      .post('/index.html')
      .send({ echoHtml: '<h1>hello world</h1>' });
    expect(responseHtml.status).toEqual(200);
    expect(responseHtml.text).toEqual('<h1>hello world</h1>');
    expect(responseHtml.header['content-type']).toEqual(
      'text/html; charset=utf-8',
    );

    const responseHtmlFail = await supertest(app)
      .post('/index.html')
      .send({ echoHtml: 'hello world' });
    expect(responseHtmlFail.status).toEqual(500);
    expect(responseHtmlFail.text).toEqual('Response validation failed');
    expect(responseHtmlFail.header['content-type']).toEqual(
      'text/html; charset=utf-8',
    );

    const responseTextPlain = await supertest(app).get('/robots.txt');
    expect(responseTextPlain.status).toEqual(200);
    expect(responseTextPlain.text).toEqual('User-agent: * Disallow: /');
    expect(responseTextPlain.header['content-type']).toEqual(
      'text/plain; charset=utf-8',
    );

    const responseCss = await supertest(app).get('/style.css');
    expect(responseCss.status).toEqual(200);
    expect(responseCss.text).toEqual('body { color: red; }');
    expect(responseCss.header['content-type']).toEqual(
      'text/css; charset=utf-8',
    );
  });

  it('should handle no content body', async () => {
    const c = initContract();

    const contract = c.router({
      noContent: {
        method: 'POST',
        path: '/:status',
        pathParams: z.object({
          status: z.coerce
            .number()
            .pipe(z.union([z.literal(200), z.literal(204)])),
        }),
        body: c.noBody(),
        responses: {
          200: c.noBody(),
          204: c.noBody(),
        },
      },
    });

    const server = initServer();
    const router = server.router(contract, {
      noContent: async ({ params }) => {
        return {
          status: params.status,
          body: undefined,
        };
      },
    });

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    createExpressEndpoints(contract, router, app);

    await supertest(app)
      .post('/200')
      .expect((res) => {
        expect(res.status).toEqual(200);
        expect(res.text).toEqual('');
        expect(res.header['content-type']).toBeUndefined();
        expect(res.header['content-length']).toStrictEqual('0');
      });

    await supertest(app)
      .post('/204')
      .expect((res) => {
        expect(res.status).toEqual(204);
        expect(res.text).toEqual('');
        expect(res.header['content-type']).toBeUndefined();
        expect(res.header['content-length']).toBeUndefined();
      });
  });

  it('should handle optional url params', async () => {
    const c = initContract();

    const contract = c.router({
      getPosts: {
        method: 'GET',
        path: '/posts/:id?',
        pathParams: z.object({
          id: z.string().optional(),
        }),
        responses: {
          200: z.object({
            id: z.string().optional(),
          }),
        },
      },
    });

    const server = initServer();
    const router = server.router(contract, {
      getPosts: async ({ params }) => {
        return {
          status: 200,
          body: {
            id: params.id,
          },
        };
      },
    });

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    createExpressEndpoints(contract, router, app);

    await supertest(app)
      .get('/posts')
      .expect((res) => {
        expect(res.status).toEqual(200);
        expect(res.body).toEqual({});
      });

    await supertest(app)
      .get('/posts/10')
      .expect((res) => {
        expect(res.status).toEqual(200);
        expect(res.body).toEqual({ id: '10' });
      });
  });
});

describe('download', () => {
  it('allows download image', async () => {
    const c = initContract();

    const contract = c.router({
      getFile: {
        method: 'GET',
        path: `/image`,
        headers: z.object({
          'Content-Type': z.string().optional(),
          'Content-disposition': z.string().optional(),
        }),
        responses: {
          200: z.unknown(),
        },
        summary: 'Get an image',
      },
    });

    const s = initServer();
    const originalFilePath = path.join(__dirname, 'assets/logo.png');

    const router = s.router(contract, {
      getFile: async ({ res }) => {
        res.setHeader('Content-type', 'image/png');

        return {
          status: 200,
          body: fs.createReadStream(originalFilePath),
        };
      },
    });

    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    createExpressEndpoints(contract, router, app, {
      responseValidation: true,
    });

    app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        if (err instanceof ResponseValidationError) {
          res.status(500).send('Response validation failed');
          return;
        }

        next(err);
      },
    );

    const responseImage = await supertest(app).get('/image');
    expect(responseImage.status).toEqual(200);
    expect(responseImage.body.toString()).toEqual(
      fs.readFileSync(originalFilePath, { encoding: 'utf-8' }),
    );
    expect(responseImage.headers['content-type']).toEqual('image/png');
  });
});
