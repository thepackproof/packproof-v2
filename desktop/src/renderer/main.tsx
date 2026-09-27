import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){return this.state.failed?<main className="startup"><h1>PackProof needs to reopen this view.</h1><p>Your staged evidence remains in the native upload queue. Restart the application to recover interrupted work.</p><button onClick={()=>location.reload()}>Reopen workspace</button></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
