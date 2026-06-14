"use client";
import { useEffect, useState } from "react";

export default function OptOut() {
  const [done, setDone] = useState(false);
  useEffect(() => {
    localStorage["umami.disabled"] = "1";
    setDone(true);
  }, []);

  return (
    <div style={{fontFamily:"system-ui,sans-serif",maxWidth:400,margin:"60px auto",padding:"0 20px",textAlign:"center"}}>
      <div style={{fontSize:"3rem"}}>✅</div>
      <div style={{marginTop:16,fontSize:"1.1rem"}}>Tracking disabled for this browser on this site.</div>
      <div style={{marginTop:8,fontSize:".85rem",color:"#666"}}>{done && location.hostname}</div>
    </div>
  );
}
