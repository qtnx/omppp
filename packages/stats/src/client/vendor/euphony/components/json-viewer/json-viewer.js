import{v as e,i as s,n as t,a as r,b as i,x as a,w as n}from"../../chunks/third-party.js";import{p as o}from"../../chunks/prismjs.js";import{p as h}from"../../chunks/css-inline.js";import{c as p}from"../../chunks/css/json-viewer.js";var d=Object.defineProperty,c=Object.getOwnPropertyDescriptor,l=(e,s,t,r)=>{for(var i,a=r>1?void 0:r?c(s,t):s,n=e.length-1;n>=0;n--)(i=e[n])&&(a=(r?i(s,t,a):i(a))||a);return r&&a&&d(s,t,a),a};let u=class extends r{constructor(){super(),this.data=null,this.isDarkTheme=!1}firstUpdated(){}willUpdate(e){}async initData(){}getHighlightedCode(e,s){if(!(s in o.languages))return i`${e}`;const t=o.languages[s],r=o.highlight(e,t,s);return i`${a(r)}`}render(){return i`
      <div class="json-viewer" ?is-dark-theme=${this.isDarkTheme}>
        <pre class="message-pre"><code>${this.getHighlightedCode(JSON.stringify(this.data,null,2),"json")}</code></pre>
      </div>
    `}};u.styles=[s`
      ${e(p)}
      ${e(h)}
    `],l([t({attribute:!1})],u.prototype,"data",2),l([t({type:Boolean,attribute:"is-dark-theme"})],u.prototype,"isDarkTheme",2),u=l([n("euphony-json-viewer")],u);export{u as EuphonyJsonViewer};