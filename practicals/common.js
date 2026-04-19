// Shared helpers for AQA Required Practical simulations
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function bindRange(inputId, valId, fmt) {
    var input = document.getElementById(inputId);
    var val = document.getElementById(valId);
    if (!input || !val) return;
    var update = function () {
      val.textContent = fmt ? fmt(input.value) : input.value;
    };
    input.addEventListener('input', update);
    update();
  }

  function addRow(tableId, cells) {
    var tbl = document.getElementById(tableId);
    if (!tbl) return;
    var tr = document.createElement('tr');
    cells.forEach(function (c) {
      var td = document.createElement('td');
      if (typeof c === 'number') {
        td.className = 'num';
        td.textContent = Number.isInteger(c) ? c : c.toFixed(2);
      } else {
        td.textContent = c;
      }
      tr.appendChild(td);
    });
    var tbody = tbl.tBodies[0] || tbl.appendChild(document.createElement('tbody'));
    tbody.appendChild(tr);
  }

  function clearTable(tableId) {
    var tbl = document.getElementById(tableId);
    if (!tbl) return;
    var tbody = tbl.tBodies[0];
    if (tbody) tbody.innerHTML = '';
  }

  // Generic line graph
  function Graph(canvas, opts) {
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = []; // [{x,y}]
    this.xLabel = opts.xLabel || 'x';
    this.yLabel = opts.yLabel || 'y';
    this.xMin = opts.xMin; this.xMax = opts.xMax;
    this.yMin = opts.yMin; this.yMax = opts.yMax;
    this.color = opts.color || '#00bcd4';
    this.title = opts.title || '';
    this._dpr();
    this.draw();
  }
  Graph.prototype._dpr = function () {
    var dpr = window.devicePixelRatio || 1;
    var r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  Graph.prototype.add = function (x, y) {
    this.data.push({ x: x, y: y });
    this.draw();
  };
  Graph.prototype.reset = function () { this.data = []; this.draw(); };
  Graph.prototype.setData = function (arr) { this.data = arr.slice(); this.draw(); };
  Graph.prototype.draw = function () {
    var c = this.canvas, ctx = this.ctx;
    var W = c.clientWidth, H = c.clientHeight;
    ctx.clearRect(0, 0, W, H);
    var pad = { l: 46, r: 14, t: 22, b: 36 };
    var plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
    // bounds
    var xs = this.data.map(function (d) { return d.x; });
    var ys = this.data.map(function (d) { return d.y; });
    var xmin = (this.xMin != null) ? this.xMin : Math.min.apply(null, xs.concat([0]));
    var xmax = (this.xMax != null) ? this.xMax : Math.max.apply(null, xs.concat([1]));
    var ymin = (this.yMin != null) ? this.yMin : Math.min.apply(null, ys.concat([0]));
    var ymax = (this.yMax != null) ? this.yMax : Math.max.apply(null, ys.concat([1]));
    if (xmax === xmin) xmax = xmin + 1;
    if (ymax === ymin) ymax = ymin + 1;
    // axes bg
    ctx.fillStyle = '#0a0c11';
    ctx.fillRect(0, 0, W, H);
    // grid
    ctx.strokeStyle = '#1e2330';
    ctx.lineWidth = 1;
    for (var i = 0; i <= 5; i++) {
      var yy = pad.t + (plotH * i) / 5;
      ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(pad.l + plotW, yy); ctx.stroke();
      var xx = pad.l + (plotW * i) / 5;
      ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, pad.t + plotH); ctx.stroke();
    }
    // axis labels
    ctx.fillStyle = '#9aa4b2';
    ctx.font = '11px system-ui, sans-serif';
    for (var j = 0; j <= 5; j++) {
      var xv = xmin + ((xmax - xmin) * j) / 5;
      var yv = ymin + ((ymax - ymin) * j) / 5;
      var xpx = pad.l + (plotW * j) / 5;
      var ypx = pad.t + plotH - (plotH * j) / 5;
      ctx.fillText(xv.toFixed(xmax - xmin >= 10 ? 0 : 2), xpx - 12, pad.t + plotH + 14);
      ctx.fillText(yv.toFixed(ymax - ymin >= 10 ? 0 : 2), 4, ypx + 4);
    }
    // axis titles
    ctx.fillStyle = '#e6f3f5';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(this.xLabel, pad.l + plotW / 2 - 30, H - 6);
    ctx.save();
    ctx.translate(12, pad.t + plotH / 2 + 30);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(this.yLabel, 0, 0);
    ctx.restore();
    if (this.title) {
      ctx.fillStyle = '#00bcd4';
      ctx.fillText(this.title, pad.l, 14);
    }
    // axis lines
    ctx.strokeStyle = '#445';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + plotH); ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();
    // plot
    if (!this.data.length) return;
    var toX = function (x) { return pad.l + ((x - xmin) / (xmax - xmin)) * plotW; };
    var toY = function (y) { return pad.t + plotH - ((y - ymin) / (ymax - ymin)) * plotH; };
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    var sorted = this.data.slice().sort(function (a, b) { return a.x - b.x; });
    sorted.forEach(function (d, i) {
      var px = toX(d.x), py = toY(d.y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    ctx.fillStyle = this.color;
    this.data.forEach(function (d) {
      var px = toX(d.x), py = toY(d.y);
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
    });
  };

  // Expose
  window.PracUtil = {
    $: $, $$: $$,
    bindRange: bindRange,
    addRow: addRow,
    clearTable: clearTable,
    Graph: Graph
  };
})();
