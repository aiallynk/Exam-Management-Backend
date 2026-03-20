import { AsyncLocalStorage } from 'node:async_hooks';

const requestContextStorage = new AsyncLocalStorage();

export const requestContextMiddleware = (req, res, next) => {
  requestContextStorage.run({ req }, () => next());
};

export const getRequestContext = () => requestContextStorage.getStore();
