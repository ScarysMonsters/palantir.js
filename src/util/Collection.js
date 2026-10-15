'use strict';

/**
 * A Map with additional utility methods. Zero dependency, API-compatible with `@discordjs/collection`.
 * @extends {Map}
 * @param {Iterable} [iterable] The iterable to initialise this collection with.
 */
class Collection extends Map {
  constructor(iterable) {
    super();
    if (iterable) {
      for (const [key, value] of iterable) this.set(key, value);
    }
  }

  /**
   * Identical to Array#at(). Returns the value at the given index.
   * @param {number} index The index of the value to get
   * @returns {*}
   */
  at(index) {
    return [...this.values()][index];
  }

  /**
   * Identical to Array#at(). Returns the key at the given index.
   * @param {number} index The index of the key to get
   * @returns {*}
   */
  keyAt(index) {
    return [...this.keys()][index];
  }

  /**
   * Returns the first value(s) in this collection.
   * @param {number} [count] The amount of values to obtain
   * @returns {*}
   */
  first(count) {
    if (count === undefined) return this.values().next().value;
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    count = Math.min(this.size, count);
    const arr = new Array(count);
    const iter = this.values();
    for (let i = 0; i < count; i++) arr[i] = iter.next().value;
    return arr;
  }

  /**
   * Returns the first key(s) in this collection.
   * @param {number} [count] The amount of keys to obtain
   * @returns {*}
   */
  firstKey(count) {
    if (count === undefined) return this.keys().next().value;
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    count = Math.min(this.size, count);
    const arr = new Array(count);
    const iter = this.keys();
    for (let i = 0; i < count; i++) arr[i] = iter.next().value;
    return arr;
  }

  /**
   * Returns the last value(s) in this collection.
   * @param {number} [count] The amount of values to obtain
   * @returns {*}
   */
  last(count) {
    const arr = [...this.values()];
    if (count === undefined) return arr[arr.length - 1];
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    return arr.slice(-count);
  }

  /**
   * Returns the last key(s) in this collection.
   * @param {number} [count] The amount of keys to obtain
   * @returns {*}
   */
  lastKey(count) {
    const arr = [...this.keys()];
    if (count === undefined) return arr[arr.length - 1];
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    return arr.slice(-count);
  }

  /**
   * Searches for a single item where the given function returns a truthy value.
   * @param {Function} fn The function to test with
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {*}
   */
  find(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    for (const [key, val] of this) {
      if (fn(val, key, this)) return val;
    }
  }

  /**
   * Searches for the key of a single item where the given function returns a truthy value.
   * @param {Function} fn The function to test with
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {*}
   */
  findKey(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    for (const [key, val] of this) {
      if (fn(val, key, this)) return key;
    }
  }

  /**
   * Obtains the value of the given key if it exists, otherwise sets and returns the value provided by the default value generator.
   * @param {*} key The key to get
   * @param {Function} defaultValue A function that returns the default value
   * @returns {*}
   */
  ensure(key, defaultValueGenerator) {
    if (this.has(key)) return this.get(key);
    if (typeof defaultValueGenerator !== 'function') throw new TypeError('defaultValueGenerator must be a function.');
    const defaultValue = defaultValueGenerator(key, this);
    this.set(key, defaultValue);
    return defaultValue;
  }

  /**
   * Identical to Array#filter().
   * @param {Function} fn The function to test with
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Collection}
   */
  filter(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const results = new this.constructor[Symbol.species]();
    for (const [key, val] of this) {
      if (fn(val, key, this)) results.set(key, val);
    }
    return results;
  }

  /**
   * Splits this collection into two, based on the given predicate.
   * @param {Function} fn The function to test with
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Collection[]}
   */
  partition(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const results = [new this.constructor[Symbol.species](), new this.constructor[Symbol.species]()];
    for (const [key, val] of this) {
      results[fn(val, key, this) ? 0 : 1].set(key, val);
    }
    return results;
  }

  /**
   * Identical to Array#flatMap().
   * @param {Function} fn Function that produces an element of the new collection
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Array}
   */
  flatMap(fn, thisArg) {
    return this.map(fn, thisArg).flat();
  }

  /**
   * Identical to Array#map().
   * @param {Function} fn Function that produces an element of the new array
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Array}
   */
  map(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const iter = this.entries();
    return Array.from({ length: this.size }, () => {
      const [key, value] = iter.next().value;
      return fn(value, key, this);
    });
  }

  /**
   * Maps each item to another value into a collection.
   * @param {Function} fn Function that produces an element of the new collection
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Collection}
   */
  mapValues(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const coll = new this.constructor[Symbol.species]();
    for (const [key, val] of this) coll.set(key, fn(val, key, this));
    return coll;
  }

  /**
   * Checks if there exists an item that passes a test.
   * @param {Function} fn Function used to test
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {boolean}
   */
  some(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    for (const [key, val] of this) {
      if (fn(val, key, this)) return true;
    }
    return false;
  }

  /**
   * Checks if all items passes a test.
   * @param {Function} fn Function used to test
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {boolean}
   */
  every(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    for (const [key, val] of this) {
      if (!fn(val, key, this)) return false;
    }
    return true;
  }

  /**
   * Returns the number of items that pass a test.
   * @param {Function} fn Function used to test
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {number}
   */
  count(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    let n = 0;
    for (const [key, val] of this) {
      if (fn(val, key, this)) n++;
    }
    return n;
  }

  /**
   * Applies a function to produce a single value.
   * @param {Function} fn Function used to reduce
   * @param {*} [initialValue] Starting value
   * @returns {*}
   */
  reduce(fn, initialValue) {
    let accumulator = initialValue;
    for (const [key, val] of this) accumulator = fn(accumulator, val, key, this);
    return accumulator;
  }

  /**
   * Executes a function on each item.
   * @param {Function} fn Function to execute
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {Collection}
   */
  each(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    for (const [key, val] of this) fn(val, key, this);
    return this;
  }

  /**
   * Removes items that satisfy the provided filter function, returning the number of removed entries.
   * @param {Function} fn Function used to test
   * @param {*} [thisArg] Value to use as `this` when executing function
   * @returns {number}
   */
  sweep(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const previousSize = this.size;
    for (const [key, val] of this) {
      if (fn(val, key, this)) this.delete(key);
    }
    return previousSize - this.size;
  }

  /**
   * Identical to Array#reverse() but returns a new collection.
   * @returns {Collection}
   */
  reverse() {
    const entries = [...this.entries()].reverse();
    this.clear();
    for (const [key, value] of entries) this.set(key, value);
    return this;
  }

  /**
   * Returns a new collection with the entries in reverse order, leaving this collection unchanged.
   * @returns {Collection}
   */
  toReversed() {
    return new this.constructor[Symbol.species]([...this.entries()].reverse());
  }

  /**
   * Sorts the collection and returns a new collection.
   * @param {Function} [compareFunction] Comparator
   * @returns {Collection}
   */
  sort(compareFunction = Collection.defaultSort) {
    const entries = [...this.entries()];
    entries.sort((a, b) => compareFunction(a[1], b[1], a[0], b[0]));
    return new this.constructor[Symbol.species](entries);
  }

  /**
   * Sorts the collection in place.
   * @param {Function} [compareFunction] Comparator
   * @returns {Collection}
   */
  sortInPlace(compareFunction = Collection.defaultSort) {
    const entries = [...this.entries()];
    entries.sort((a, b) => compareFunction(a[1], b[1], a[0], b[0]));
    this.clear();
    for (const [key, value] of entries) this.set(key, value);
    return this;
  }

  /**
   * Combines this collection with others into a new collection.
   * @param {...Collection} collections The collections to merge
   * @returns {Collection}
   */
  concat(...collections) {
    const newColl = new this.constructor[Symbol.species](this);
    for (const coll of collections) {
      for (const [key, val] of coll) newColl.set(key, val);
    }
    return newColl;
  }

  /**
   * Checks if this collection shares identical entries with another collection.
   * @param {Collection} collection The collection to compare with
   * @returns {boolean}
   */
  equals(collection) {
    if (this === collection) return true;
    if (this.size !== collection.size) return false;
    for (const [key, value] of this) {
      if (!collection.has(key) || value !== collection.get(key)) return false;
    }
    return true;
  }

  /**
   * Returns a new collection containing the items from this and the other collection.
   * @param {Collection} other The other collection
   * @returns {Collection}
   */
  union(other) {
    return this.concat(other);
  }

  /**
   * Returns a new collection containing the items that are in this collection but not the other.
   * @param {Collection} other The other collection
   * @returns {Collection}
   */
  difference(other) {
    const diff = new this.constructor[Symbol.species]();
    for (const [key, value] of this) {
      if (!other.has(key)) diff.set(key, value);
    }
    return diff;
  }

  /**
   * Returns a new collection containing the items that are in both collections.
   * @param {Collection} other The other collection
   * @returns {Collection}
   */
  intersection(other) {
    const inter = new this.constructor[Symbol.species]();
    for (const [key, value] of this) {
      if (other.has(key)) inter.set(key, value);
    }
    return inter;
  }

  /**
   * Returns a new collection containing the items from this collection that are not in the other.
   * Identical to {@link Collection#difference}.
   * @param {Collection} other The other collection
   * @returns {Collection}
   */
  subtract(other) {
    return this.difference(other);
  }

  /**
   * Merges this collection with others into this collection.
   * @param {...Collection} collections The collections to merge
   * @returns {Collection}
   */
  merge(...collections) {
    for (const coll of collections) {
      for (const [key, val] of coll) this.set(key, val);
    }
    return this;
  }

  /**
   * Checks if all items in the given collection are in this collection.
   * @param {Collection|Array} collection The collection to check
   * @returns {boolean}
   */
  hasAll(collection) {
    const values = collection instanceof Collection ? [...collection.keys()] : collection;
    return values.every(value => this.has(value));
  }

  /**
   * Returns a random value from this collection.
   * @param {number} [count] Amount of random values to obtain
   * @returns {*}
   */
  random(count) {
    if (count === undefined) return this.at(Math.floor(Math.random() * this.size));
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    const values = [...this.values()];
    const out = [];
    for (let i = 0; i < count; i++) {
      if (values.length === 0) return out;
      out.push(values.splice(Math.floor(Math.random() * values.length), 1)[0]);
    }
    return out;
  }

  /**
   * Returns a random key from this collection.
   * @param {number} [count] Amount of random keys to obtain
   * @returns {*}
   */
  randomKey(count) {
    if (count === undefined) return this.keyAt(Math.floor(Math.random() * this.size));
    if (typeof count !== 'number') throw new TypeError('The count must be a number.');
    if (!Number.isInteger(count) || count < 0) throw new RangeError('The count must be an integer greater than 0.');
    const keys = [...this.keys()];
    const out = [];
    for (let i = 0; i < count; i++) {
      if (keys.length === 0) return out;
      out.push(keys.splice(Math.floor(Math.random() * keys.length), 1)[0]);
    }
    return out;
  }

  /**
   * Creates an identical shallow copy of this collection.
   * @returns {Collection}
   */
  clone() {
    return new this.constructor[Symbol.species](this);
  }

  /**
   * Groups elements by the return value of the key function.
   * @param {Function} fn The function to use for grouping
   * @returns {Collection}
   */
  groupBy(fn, thisArg) {
    if (typeof thisArg !== 'undefined') fn = fn.bind(thisArg);
    const coll = new this.constructor[Symbol.species]();
    for (const [key, val] of this) {
      const group = fn(val, key, this);
      const values = coll.get(group) ?? [];
      values.push(val);
      coll.set(group, values);
    }
    return coll;
  }

  /**
   * Returns an array of values.
   * @returns {Array}
   */
  toArray() {
    return [...this.values()];
  }

  /**
   * @returns {Array}
   */
  toJSON() {
    return [...this.values()];
  }

  /**
   * The default sort function.
   * @param {*} a First value
   * @param {*} b Second value
   * @returns {number}
   */
  static defaultSort(a, b) {
    return Number(a > b) - Number(a < b);
  }

  static get [Symbol.species]() {
    return Collection;
  }
}

module.exports = { Collection };
