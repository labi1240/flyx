var PROVIDERS = {
  dlhd:'DLHD Live TV', flixer:'Flixer/Hexa', videasy:'Videasy',
  animekai:'AnimeKai/MegaUp', hianime:'HiAnime', miruro:'Miruro',
  vidsrc:'VidSrc/2embed', ntv:'NTV', bingebox:'BingeBox',
  moviebox:'MovieBox', primesrc:'PrimeSrc', ufreetv:'uFreeTV',
  globetv:'GlobeTV', cdnlive:'CDN-Live', viprow:'VIPRow',
  ppv:'PPV', stream:'Generic Stream'
};

var state = { stats:{}, providerState:{} };

function load() {
  chrome.runtime.sendMessage({type:'getStatus'}).then(function(r){
    if (r) {
      state.stats = r.stats || {};
      state.providerState = r.providerState || {};
    }
    render();
  }).catch(function(){
    chrome.storage.local.get(['stats','providerState'], function(r){
      state.stats = r.stats || {};
      state.providerState = r.providerState || {};
      render();
    });
  });
}

function render() {
  var s = state.stats;
  document.getElementById('sInt').textContent = fmt(s.intercepted||0);
  document.getElementById('sOk').textContent = fmt(s.success||0);
  document.getElementById('sErr').textContent = fmt(s.error||0);
  document.getElementById('sM3').textContent = fmt(s.m3u8||0);

  var list = document.getElementById('providers');
  list.innerHTML = '';
  Object.keys(PROVIDERS).forEach(function(id){
    var on = state.providerState[id] !== false;
    var row = document.createElement('div');
    row.className = 'toggle-row' + (on ? '' : ' off');
    row.innerHTML = '<span class="toggle-name">'+PROVIDERS[id]+'</span>' +
      '<label class="toggle"><input type="checkbox" data-id="'+id+'"'+(on?' checked':'')+
      '><span class="toggle-slider"></span></label>';
    row.querySelector('input').addEventListener('change',function(e){
      chrome.runtime.sendMessage({type:'toggle',id:id,on:e.target.checked});
      load();
    });
    list.appendChild(row);
  });
}

function fmt(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000) return (n/1000).toFixed(1)+'K';
  return String(n);
}

document.getElementById('wlBtn').addEventListener('click',function(){
  var ch = document.getElementById('wlChan').value.trim();
  if (!ch) return;
  var key = ch.startsWith('premium') ? ch : 'premium'+ch;
  var btn = document.getElementById('wlBtn');
  var st = document.getElementById('wlStatus');
  btn.disabled = true; btn.textContent = 'Solving...';
  st.innerHTML = '<span class="pending">Solving reCAPTCHA...</span>';
  chrome.runtime.sendMessage({type:'whitelist',ch:key}).then(function(r){
    btn.disabled = false; btn.textContent = 'Whitelist IP';
    if (r.success) {
      st.innerHTML = '<span class="ok">&#10003; Token ready! IP whitelisted for 20-30 min</span>';
    } else {
      st.innerHTML = '<span class="err">&#10007; '+(r.error||r.err||'Failed')+'</span>';
    }
  }).catch(function(e){
    btn.disabled = false; btn.textContent = 'Whitelist IP';
    st.innerHTML = '<span class="err">&#10007; '+e.message+'</span>';
  });
});

document.getElementById('resetBtn').addEventListener('click',function(){
  chrome.runtime.sendMessage({type:'resetStats'});
  load();
});

load();
setInterval(load, 3000);
