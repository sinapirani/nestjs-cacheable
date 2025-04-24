import { Cache } from 'cache-manager';
import * as serialize from 'serialize-javascript';
import { CacheEvictKeyBuilder, CacheKeyBuilder } from './cacheable.interface';
import { createHash } from 'crypto';

let cacheManager: Cache | undefined;
let cacheManagerIsv5OrGreater = false;
export function setCacheManager(m: Cache) {
  cacheManager = m;
}

export function getCacheManager() {
  return cacheManager;
}

export function setCacheManagerIsv5OrGreater(val: boolean) {
  return (cacheManagerIsv5OrGreater = val);
}

type KeyType = string | string[] | CacheKeyBuilder | CacheEvictKeyBuilder;

/**
 * try extract valid key from build function or fixed string
 */
function extract(keyBuilder: KeyType, args: any[]): string[] {
  const keys =
    keyBuilder instanceof Function ? keyBuilder(...args) : keyBuilder;
  return Array.isArray(keys) ? keys : [keys];
}

/**
 * generateComposedKey
 * generate the final cache key, compose of use key and namespace(option), like 'namespace:key'
 */
export function generateComposedKey(options: {
  key?: string | CacheKeyBuilder | CacheEvictKeyBuilder;
  namespace?: string | CacheKeyBuilder;
  methodName: string;
  args: any[];
}): string[] {
  let keys: string[];
  if (options.key) {
    keys = extract(options.key, options.args);
  } else {
    const hash = createHash('md5')
      .update(serialize(options.args))
      .digest('hex');
    keys = [`${options.methodName}@${hash}`];
  }
  const namespace =
    options.namespace && extract(options.namespace, options.args);
  return keys.map((it) => (namespace ? `${namespace[0]}:${it}` : it));
}

const pendingCacheMap = new Map<string, Promise<any>>();

/**
 * Special wrapper object to distinguish between "null value stored in cache" 
 * and "no value found in cache"
 */
interface CacheWrapper {
  hasValue: boolean;
  value: any;
}

async function fetchCachedValue(key: string): Promise<CacheWrapper> {
  let pendingCachePromise = pendingCacheMap.get(key);
  if (!pendingCachePromise) {
    pendingCachePromise = getCacheManager().get(key);
    pendingCacheMap.set(key, pendingCachePromise);
  }
  let rawValue;
  try {
    rawValue = await pendingCachePromise;
    // If we get here, cache lookup was successful, even if value is null
    return { hasValue: true, value: rawValue };
  } catch (e) {
    throw e;
  } finally {
    pendingCacheMap.delete(key);
  }
}

const pendingMethodCallMap = new Map<string, Promise<any>>();

export async function cacheableHandle(
  key: string,
  method: () => Promise<any>,
  ttl?: number,
) {
  try {
    const cachedResult = await fetchCachedValue(key);
    // Only proceed with method execution if no value was found in cache
    // This properly handles null/undefined values that were explicitly cached
    if (cachedResult.hasValue) return cachedResult.value;
  } catch {}
  
  let pendingMethodCallPromise = pendingMethodCallMap.get(key);
  if (!pendingMethodCallPromise) {
    pendingMethodCallPromise = method();
    pendingMethodCallMap.set(key, pendingMethodCallPromise);
  }
  
  let value;
  try {
    value = await pendingMethodCallPromise;
  } catch (e) {
    throw e;
  } finally {
    pendingMethodCallMap.delete(key);
  }
  
  // v5 ttl ; v4 {ttl:ttl}
  await cacheManager.set(
    key,
    value,
    cacheManagerIsv5OrGreater ? ttl : ({ ttl: ttl } as any),
  );
  return value;
}