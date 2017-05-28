let insertFuncs = [
  (tree, id, server) => {
    tree.push(server);
  },
  (tree, id, server) => {
    if (id % 2 === 0) {
      tree[1] = make([tree[0]]);
      tree[0] = make([server]);
    } else {
      tree[0] = make([tree[0]]);
      tree[1] = make([server]);
    }
  },
  (tree, id, server) => {
    while (tree.length === 2) {
      let z = id % 2;
      tree = tree[z === 1 ? 1 : 0];
      id >>= 1;
    }
    insertFuncs[tree.length](tree, id, server);
  },
];

let getFuncs = [
  () => null,
  (tree) => ({ val: tree[0], id: 0 }),
  (tree, id) => {
    let resId = 0,
        st2 = 1;
    do {
      let z = id % 2;
      tree = tree[z === 1 ? 1 : 0];
      id >>= 1;
      resId += st2 * z;
      st2 <<= 1;
    } while (tree.length === 2);
    return { 
      val: getFuncs[tree.length](tree, id),
      id: resId,
    };
  }
];

let getExactlyFuncs = [
  getFuncs[0],
  (tree, id) => id === 0 
              ? { val: tree[0], id: 0 }
              : null,
  (tree, id) => {
    let resId = 0,
        varId = id,
        st2 = 1;
    do {
      let z = varId % 2;
      tree = tree[z === 1 ? 1 : 0];
      varId >>= 1;
      resId += st2 * z;
      st2 <<= 1;
    } while (tree.length === 2);
    let res = getExactlyFuncs[tree.length](tree, varId); 
    if (res !== null) {
      let { val } = res;
      return id === resId
           ? { val, id: resId }
           : null;
    } else {
      return null;
    }
  },
];

function Tree() {}
Tree.prototype = [];
Tree.prototype.isEmpty = function() {
  return this.length === 0;
}
Tree.prototype.insert = function(id, elem) {
  return insertFuncs[this.length](this, id, elem);
}
Tree.prototype.get = function(id) {
  return getFuncs[this.length](this, id);
}
Tree.prototype.getExactly = function(id) {
  return getExactlyFuncs[this.length](this, id);
}

function make(arr) {
  return Object.setPrototypeOf(arr, Tree.prototype);
}

function empty() { return make([]); }

module.exports = {
  make,
  empty,
};
